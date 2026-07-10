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
  const [mempoolPressure, setMempoolPressure] = useState(0);
  const [lastBlockAt, setLastBlockAt] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;

    fetch(`/api/blocks?limit=${MAX_BLOCKS}`)
      .then((r) => r.json())
      .then((data: { blocks: ApiBlock[] }) => {
        if (cancelled) return;
        const ordered = [...data.blocks].reverse(); // API returns newest-first; we want oldest-first left-to-right
        setBlocks(ordered);
        if (ordered.length) {
          setChainHeight(ordered[ordered.length - 1].height);
          setLastBlockAt(Date.now());
        }
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
          setLastBlockAt(Date.now());
          setBlocks((prev) => {
            if (prev.some((b) => b.hash === hash)) return prev;
            const next = [...prev, { height, hash, txCount, residual, miner, timestamp }];
            return next.slice(-MAX_BLOCKS);
          });
        } else if (msg.type === "mempool_update") {
          const data = msg.data as { size: number; pressure: number };
          setMempoolPressure(data.pressure ?? 0);
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

  return { blocks, connected, chainHeight, mempoolPressure, lastBlockAt };
}

// ── A single minted block, rendered from real residual/txCount/finality data ──
//
// "Alive" behaviour (all driven by real per-block data, nothing scripted):
//  - Spawn-in rise + scale when the block first arrives over the WS feed.
//  - Continuous idle bob (each block's phase is derived from its own hash so
//    the timeline reads as a gently breathing structure, not a frozen diorama).
//  - Crystallized (low-residual) blocks pulse an incandescent emissive glow;
//    the pulse speed and peak intensity are driven by how far below the
//    threshold the actual residual sits — a tighter solve visibly "hums" harder.
//  - Non-crystalline blocks keep a slow tumble, matching the original concept's
//    "still searching for stability" read.

function hashToUnit(hash: string): number {
  let h = 0;
  for (let i = 0; i < hash.length; i++) h = (h * 31 + hash.charCodeAt(i)) >>> 0;
  return (h % 1000) / 1000;
}

function Block({ block, index, isNew }: { block: ApiBlock; index: number; isNew: boolean }) {
  const meshRef = useRef<THREE.Mesh>(null);
  const materialRef = useRef<THREE.MeshPhysicalMaterial>(null);
  const spawn = useRef(isNew ? 0 : 1);
  const phase = useMemo(() => hashToUnit(block.hash) * Math.PI * 2, [block.hash]);

  const size = Math.max(1.1, Math.min(2.4, 1.1 + block.txCount / 8));
  const isCrystalline = block.residual <= RESIDUAL_TARGET;
  // How far past the threshold the solve landed — drives glow intensity/speed.
  const solveDepth = isCrystalline ? Math.min(3, Math.log10(RESIDUAL_TARGET / Math.max(block.residual, 1e-12))) : 0;

  const color = useMemo(() => {
    if (isCrystalline) return new THREE.Color("#22d3ee"); // Equilibrium cyan
    const t = Math.min(1, block.residual / 1e-5);
    return new THREE.Color().lerpColors(new THREE.Color("#f97316"), new THREE.Color("#facc15"), 1 - t);
  }, [block.residual, isCrystalline]);

  useFrame(({ clock }, delta) => {
    if (spawn.current < 1) spawn.current = Math.min(1, spawn.current + delta * 2.2);
    if (!meshRef.current) return;
    const eased = 1 - Math.pow(1 - spawn.current, 3);
    const t = clock.elapsedTime;

    meshRef.current.scale.setScalar(size * eased);
    // Idle bob: each block breathes on its own phase so the row feels alive at rest.
    const bob = Math.sin(t * 0.9 + phase) * 0.08;
    meshRef.current.position.y = (1 - eased) * -3 + (eased > 0.98 ? bob : 0);

    if (isCrystalline) {
      // Settled blocks hum gently in place rather than tumbling.
      meshRef.current.rotation.y = Math.sin(t * 0.3 + phase) * 0.08;
    } else {
      meshRef.current.rotation.y += delta * 0.15;
    }

    if (materialRef.current) {
      if (isCrystalline) {
        const pulseSpeed = 1.2 + solveDepth * 0.6;
        const pulse = (Math.sin(t * pulseSpeed + phase) + 1) / 2;
        materialRef.current.emissive = color;
        materialRef.current.emissiveIntensity = 0.25 + pulse * (0.35 + solveDepth * 0.25);
      } else {
        materialRef.current.emissiveIntensity = 0;
      }
    }
  });

  return (
    <group position={[index * SPACING, 0, 0]}>
      <mesh ref={meshRef} castShadow receiveShadow>
        <boxGeometry args={[1, 1, 1]} />
        <meshPhysicalMaterial
          ref={materialRef}
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

// ── The "next block forming" particle ────────────────────────────────────────
//
// Descends toward the timeline as real wall-clock time elapses since the last
// block, approaching (never reaching, until the real WS event fires) the slot
// where the next block will land. Progress is driven by lastBlockAt (a real
// timestamp), not a fake timer — if the chain stalls, the particle visibly
// stalls high in the air instead of pretending to solve.

function MiningParticle({ lastBlockAt, mempoolPressure, xTarget }: { lastBlockAt: number | null; mempoolPressure: number; xTarget: number }) {
  const ref = useRef<THREE.Mesh>(null);
  const AVG_BLOCK_MS = 15_000;

  useFrame(({ clock }) => {
    if (!ref.current || lastBlockAt === null) return;
    const elapsed = Date.now() - lastBlockAt;
    const progress = Math.min(0.97, elapsed / AVG_BLOCK_MS); // never fully lands; the real block event handles that
    const t = clock.elapsedTime;

    // Height above the timeline shrinks as the solver approaches equilibrium;
    // turbulence (jitter) scales with mempool pressure, echoing "harder search".
    const turbulence = 0.15 + Math.min(1, mempoolPressure / 20) * 0.35;
    const jitterX = Math.sin(t * 4.3) * turbulence * (1 - progress);
    const jitterZ = Math.cos(t * 3.7) * turbulence * (1 - progress);

    ref.current.position.set(xTarget + jitterX, 2.4 * (1 - progress) + 0.3, jitterZ);
    ref.current.scale.setScalar(0.35 + progress * 0.15);

    const material = ref.current.material as THREE.MeshBasicMaterial;
    const hot = 1 - progress; // red/chaotic while far from equilibrium
    material.color.setRGB(1, 0.35 + progress * 0.5, hot * 0.1 + progress * 0.85);
  });

  if (lastBlockAt === null) return null;

  return (
    <mesh ref={ref}>
      <sphereGeometry args={[1, 16, 16]} />
      <meshBasicMaterial toneMapped={false} />
    </mesh>
  );
}

function Scene({
  blocks,
  lastBlockAt,
  mempoolPressure,
}: {
  blocks: ApiBlock[];
  lastBlockAt: number | null;
  mempoolPressure: number;
}) {
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
      <MiningParticle lastBlockAt={lastBlockAt} mempoolPressure={mempoolPressure} xTarget={blocks.length * SPACING} />
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
  const { blocks, connected, chainHeight, mempoolPressure, lastBlockAt } = useLiveBlocks();
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
        <Scene blocks={blocks} lastBlockAt={lastBlockAt} mempoolPressure={mempoolPressure} />
        <Environment preset="city" />
        <OrbitControls
          enablePan={false}
          minDistance={4}
          maxDistance={30}
          autoRotate
          autoRotateSpeed={0.35}
        />
      </Canvas>
    </div>
  );
}

export default BlockChain3D;
