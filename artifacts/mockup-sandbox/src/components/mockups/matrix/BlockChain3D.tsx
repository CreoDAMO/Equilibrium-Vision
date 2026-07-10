import { useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { OrbitControls, Text, Environment } from "@react-three/drei";
import * as THREE from "three";

// ── Real data types (mirror the running API server, not mocked) ─────────────

interface ApiBlock {
  height: number;
  hash: string;
  txCount: number;
  residual: number;
  residualFp?: number;
  miner: string;
  timestamp: number;
  finalized?: boolean;
}

interface NewBlockEvent {
  type: "new_block";
  data: { height: number; hash: string; txCount: number; residual: number; miner: string; timestamp: number };
}

type WsEvent = { type: "connected" } | { type: "ping" } | NewBlockEvent | { type: "mempool_update"; data: unknown };

const MAX_BLOCKS = 24;
const SPACING = 3.2;
const RESIDUAL_TARGET = 1e-7; // same threshold used elsewhere in the app for "hyper-optimized"

// ── Data hook: real REST fetch + real WebSocket, same endpoints the Explorer uses ──

function useLiveBlocks() {
  const [blocks, setBlocks] = useState<ApiBlock[]>([]);
  const [connected, setConnected] = useState(false);
  const [chainHeight, setChainHeight] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;

    fetch(`/api/blocks?limit=${MAX_BLOCKS}`)
      .then((r) => r.json())
      .then((data: { blocks: ApiBlock[] }) => {
        if (cancelled) return;
        const ordered = [...data.blocks].reverse(); // API returns newest-first; we want oldest-first left-to-right
        setBlocks(ordered);
        if (ordered.length) setChainHeight(ordered[ordered.length - 1].height);
      })
      .catch(() => {});

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);

    ws.onopen = () => setConnected(true);
    ws.onclose = () => setConnected(false);
    ws.onerror = () => setConnected(false);
    ws.onmessage = (event: MessageEvent<string>) => {
      try {
        const msg = JSON.parse(event.data) as WsEvent;
        if (msg.type === "new_block") {
          const { height, hash, txCount, residual, miner, timestamp } = msg.data;
          setChainHeight(height);
          setBlocks((prev) => {
            if (prev.some((b) => b.hash === hash)) return prev;
            const next = [...prev, { height, hash, txCount, residual, miner, timestamp }];
            return next.slice(-MAX_BLOCKS);
          });
        }
      } catch {
        // ignore malformed frames
      }
    };

    return () => {
      cancelled = true;
      ws.close();
    };
  }, []);

  return { blocks, connected, chainHeight };
}

// ── A single minted block, rendered from real residual/txCount/finality data ──

function Block({ block, index, isNew }: { block: ApiBlock; index: number; isNew: boolean }) {
  const meshRef = useRef<THREE.Mesh>(null);
  const spawn = useRef(isNew ? 0 : 1);

  const size = Math.max(1.1, Math.min(2.4, 1.1 + block.txCount / 8));
  const isCrystalline = block.residual <= RESIDUAL_TARGET;

  const color = useMemo(() => {
    if (isCrystalline) return new THREE.Color("#22d3ee"); // Equilibrium cyan
    const t = Math.min(1, block.residual / 1e-5);
    return new THREE.Color().lerpColors(new THREE.Color("#f97316"), new THREE.Color("#facc15"), 1 - t);
  }, [block.residual, isCrystalline]);

  useFrame((_, delta) => {
    if (spawn.current < 1) spawn.current = Math.min(1, spawn.current + delta * 2.2);
    if (!meshRef.current) return;
    const eased = 1 - Math.pow(1 - spawn.current, 3);
    meshRef.current.scale.setScalar(size * eased);
    meshRef.current.position.y = (1 - eased) * -3;
    meshRef.current.rotation.y += isCrystalline ? 0 : delta * 0.15;
  });

  return (
    <group position={[index * SPACING, 0, 0]}>
      <mesh ref={meshRef} castShadow receiveShadow>
        <boxGeometry args={[1, 1, 1]} />
        <meshPhysicalMaterial
          color={color}
          roughness={isCrystalline ? 0.05 : 0.55}
          transmission={isCrystalline ? 0.85 : 0.1}
          thickness={1.2}
          ior={1.45}
          transparent
          opacity={isCrystalline ? 0.92 : 1}
          metalness={isCrystalline ? 0 : 0.2}
        />
      </mesh>
      <Text position={[0, -size / 2 - 0.5, 0]} fontSize={0.32} color="#94a3b8" anchorX="center">
        {`#${block.height}`}
      </Text>
      <Text position={[0, -size / 2 - 0.9, 0]} fontSize={0.22} color={isCrystalline ? "#22d3ee" : "#fb923c"} anchorX="center">
        {block.residual.toExponential(2)}
      </Text>
    </group>
  );
}

function Scene({ blocks }: { blocks: ApiBlock[] }) {
  const seenHeights = useRef(new Set<number>());
  const newestHeight = blocks.length ? blocks[blocks.length - 1].height : -1;

  const items = blocks.map((b, i) => {
    const isNew = !seenHeights.current.has(b.height) && b.height === newestHeight;
    seenHeights.current.add(b.height);
    return { block: b, index: i, isNew };
  });

  const centerOffset = blocks.length ? -((blocks.length - 1) * SPACING) / 2 : 0;

  return (
    <group position={[centerOffset, 0, 0]}>
      {items.map(({ block, index, isNew }) => (
        <Block key={block.hash} block={block} index={index} isNew={isNew} />
      ))}
      {/* Timeline rail */}
      {blocks.length > 1 && (
        <mesh position={[((blocks.length - 1) * SPACING) / 2, -1.7, 0]}>
          <boxGeometry args={[blocks.length * SPACING, 0.03, 0.03]} />
          <meshBasicMaterial color="#334155" />
        </mesh>
      )}
    </group>
  );
}

function hasWebGL(): boolean {
  try {
    const canvas = document.createElement("canvas");
    return !!(canvas.getContext("webgl2") || canvas.getContext("webgl"));
  } catch {
    return false;
  }
}

export function BlockChain3D() {
  const { blocks, connected, chainHeight } = useLiveBlocks();
  const [glSupported, setGlSupported] = useState(true);

  useEffect(() => {
    setGlSupported(hasWebGL());
  }, []);

  if (!glSupported) {
    return (
      <div className="w-screen h-screen bg-[#05060a] flex items-center justify-center text-slate-400 text-sm px-8 text-center">
        WebGL is unavailable in this preview environment (common for headless/sandboxed browsers). This component
        renders normally in a real desktop or mobile browser with GPU access.
      </div>
    );
  }

  return (
    <div className="relative w-screen h-screen bg-[#05060a] overflow-hidden">
      <div className="absolute top-0 left-0 right-0 z-10 flex items-center justify-between px-6 py-4 pointer-events-none">
        <div>
          <h1 className="text-white text-lg font-semibold tracking-wide">Equilibrium — Kinetic Block Timeline</h1>
          <p className="text-slate-400 text-sm">Live 3D view of blocks as they are mined · Proof-of-Stationarity residual → material clarity</p>
        </div>
        <div className="flex items-center gap-2 text-sm text-slate-300">
          <span className={`inline-block w-2 h-2 rounded-full ${connected ? "bg-cyan-400" : "bg-red-500"}`} />
          {connected ? "Live" : "Reconnecting…"}
          {chainHeight !== null && <span className="text-slate-500 ml-3">Tip #{chainHeight}</span>}
        </div>
      </div>

      {blocks.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center text-slate-500 text-sm">
          Waiting for blocks from the running API server…
        </div>
      )}

      <Canvas
        shadows
        camera={{ position: [6, 4, 12], fov: 45 }}
        gl={{ antialias: true, powerPreference: "default", failIfMajorPerformanceCaveat: false }}
      >
        <color attach="background" args={["#05060a"]} />
        <fog attach="fog" args={["#05060a", 12, 40]} />
        <ambientLight intensity={0.4} />
        <directionalLight position={[8, 10, 6]} intensity={1.2} castShadow />
        <pointLight position={[-6, 3, -4]} intensity={0.6} color="#38bdf8" />
        <Scene blocks={blocks} />
        <Environment preset="city" />
        <OrbitControls enablePan={false} minDistance={4} maxDistance={30} />
      </Canvas>
    </div>
  );
}

export default BlockChain3D;
