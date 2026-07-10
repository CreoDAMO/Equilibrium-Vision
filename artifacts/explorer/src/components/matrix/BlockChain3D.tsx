import { useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { OrbitControls, Text, Environment } from "@react-three/drei";
import * as THREE from "three";
import {
  useListBlocks,
  useGetMempool,
  getListBlocksQueryKey,
  getGetMempoolQueryKey,
} from "@workspace/api-client-react";
import type { Block } from "@workspace/api-client-react";

// ── Real data: reuses the same generated API hooks as every other page.
// The app-wide useChainWebSocket() (mounted once in App.tsx) invalidates
// these query keys the instant a new_block / mempool_update event arrives,
// so this component gets live pushes with no separate WS connection. ────────

const MAX_BLOCKS = 24;
const SPACING = 3.2;
const RESIDUAL_TARGET = 1e-7; // matches the "hyper-optimized" threshold used elsewhere in the app

function useLiveBlocks() {
  const { data, isLoading } = useListBlocks(
    { limit: MAX_BLOCKS },
    { query: { queryKey: getListBlocksQueryKey({ limit: MAX_BLOCKS }), refetchInterval: 10_000 } },
  );
  const { data: mempool } = useGetMempool({
    query: { queryKey: getGetMempoolQueryKey(), refetchInterval: 10_000 },
  });

  const blocks = useMemo(() => [...(data?.blocks ?? [])].reverse(), [data]); // API returns newest-first; render oldest→newest left-to-right

  const chainHeight = blocks.length ? blocks[blocks.length - 1].height : null;

  // Track wall-clock time of the last height change so the mining particle
  // can animate off a real "time since last block" signal, not a fake timer.
  const lastHeightRef = useRef<number | null>(null);
  const [lastBlockAt, setLastBlockAt] = useState<number | null>(null);
  useEffect(() => {
    if (chainHeight === null) return;
    if (lastHeightRef.current !== chainHeight) {
      lastHeightRef.current = chainHeight;
      setLastBlockAt(Date.now());
    }
  }, [chainHeight]);

  return {
    blocks,
    isLoading,
    chainHeight,
    mempoolPressure: mempool?.pressure ?? 0,
    lastBlockAt,
  };
}

// ── A single minted block, rendered from real residual/txCount/finality data ──
//
// "Alive" behaviour (all driven by real per-block data, nothing scripted):
//  - Spawn-in rise + scale when the block first appears in the query cache.
//  - Continuous idle bob (each block's phase is derived from its own hash so
//    the timeline reads as a gently breathing structure, not a frozen diorama).
//  - Crystallized (low-residual) blocks pulse an incandescent emissive glow;
//    the pulse speed and peak intensity are driven by how far below the
//    threshold the actual residual sits — a tighter solve visibly "hums" harder.
//  - Non-crystalline blocks keep a slow tumble, reading as "still searching".

function hashToUnit(hash: string): number {
  let h = 0;
  for (let i = 0; i < hash.length; i++) h = (h * 31 + hash.charCodeAt(i)) >>> 0;
  return (h % 1000) / 1000;
}

function Block({ block, index, isNew }: { block: Block; index: number; isNew: boolean }) {
  const meshRef = useRef<THREE.Mesh>(null);
  const materialRef = useRef<THREE.MeshPhysicalMaterial>(null);
  const spawn = useRef(isNew ? 0 : 1);
  const phase = useMemo(() => hashToUnit(block.hash) * Math.PI * 2, [block.hash]);

  const size = Math.max(1.1, Math.min(2.4, 1.1 + block.txCount / 8));
  const isCrystalline = block.residual <= RESIDUAL_TARGET;
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
    const bob = Math.sin(t * 0.9 + phase) * 0.08;
    meshRef.current.position.y = (1 - eased) * -3 + (eased > 0.98 ? bob : 0);

    if (isCrystalline) {
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
// block, approaching (never reaching, until the real query cache reflects a
// new height) the slot where the next block will land. If the chain stalls,
// the particle visibly stalls high in the air instead of pretending to solve.

function MiningParticle({
  lastBlockAt,
  mempoolPressure,
  xTarget,
}: {
  lastBlockAt: number | null;
  mempoolPressure: number;
  xTarget: number;
}) {
  const ref = useRef<THREE.Mesh>(null);
  const AVG_BLOCK_MS = 15_000;

  useFrame(({ clock }) => {
    if (!ref.current || lastBlockAt === null) return;
    const elapsed = Date.now() - lastBlockAt;
    const progress = Math.min(0.97, elapsed / AVG_BLOCK_MS);
    const t = clock.elapsedTime;

    const turbulence = 0.15 + Math.min(1, mempoolPressure / 20) * 0.35;
    const jitterX = Math.sin(t * 4.3) * turbulence * (1 - progress);
    const jitterZ = Math.cos(t * 3.7) * turbulence * (1 - progress);

    ref.current.position.set(xTarget + jitterX, 2.4 * (1 - progress) + 0.3, jitterZ);
    ref.current.scale.setScalar(0.35 + progress * 0.15);

    const material = ref.current.material as THREE.MeshBasicMaterial;
    const hot = 1 - progress;
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
  blocks: Block[];
  lastBlockAt: number | null;
  mempoolPressure: number;
}) {
  // Bounded to the currently visible window (keyed on hash, not just height,
  // so a reorg replacing a height is still treated as "new") — rebuilt from
  // the live `blocks` list each time rather than growing forever.
  const seenHashes = useRef(new Set<string>());
  const newestHeight = blocks.length ? blocks[blocks.length - 1].height : -1;

  const items = blocks.map((b, i) => {
    const isNew = !seenHashes.current.has(b.hash) && b.height === newestHeight;
    return { block: b, index: i, isNew };
  });

  seenHashes.current = new Set(blocks.map((b) => b.hash));

  const centerOffset = blocks.length ? -((blocks.length - 1) * SPACING) / 2 : 0;

  return (
    <group position={[centerOffset, 0, 0]}>
      {items.map(({ block, index, isNew }) => (
        <Block key={block.hash} block={block} index={index} isNew={isNew} />
      ))}
      <MiningParticle lastBlockAt={lastBlockAt} mempoolPressure={mempoolPressure} xTarget={blocks.length * SPACING} />
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
  const { blocks, isLoading, chainHeight, mempoolPressure, lastBlockAt } = useLiveBlocks();
  const [glSupported, setGlSupported] = useState(true);

  useEffect(() => {
    setGlSupported(hasWebGL());
  }, []);

  if (!glSupported) {
    return (
      <div className="w-full h-[calc(100vh-8rem)] min-h-[480px] rounded-lg border bg-[#05060a] flex items-center justify-center text-slate-400 text-sm px-8 text-center">
        WebGL is unavailable in this browser or device (no GPU access). The 3D timeline needs hardware-accelerated
        graphics to render — try a desktop browser with WebGL enabled.
      </div>
    );
  }

  return (
    <div className="relative w-full h-[calc(100vh-8rem)] min-h-[480px] rounded-lg border overflow-hidden bg-[#05060a]">
      {!isLoading && blocks.length === 0 && (
        <div className="absolute inset-0 z-10 flex items-center justify-center text-slate-500 text-sm">
          No blocks yet — waiting for the chain to mine its first block.
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
        <OrbitControls enablePan={false} minDistance={4} maxDistance={30} autoRotate autoRotateSpeed={0.35} />
      </Canvas>
    </div>
  );
}

export default BlockChain3D;
