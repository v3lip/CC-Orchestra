/**
 * CC Fleet wire protocol, version 1.
 *
 * Shared by the backend, the simulator and (by hand-mirroring, see docs/protocol.md)
 * the Lua turtle agent. Every message is one JSON object per WebSocket text frame:
 *
 *   { "v": 1, "type": "...", "id": "<message id>", "ts": <sender epoch ms>, ...fields }
 *
 * Lua's textutils.serializeJSON on CC: Tweaked 1.100 encodes an empty table as `{}`,
 * so every array field accepts `{}` as an empty array. Turtle messages never use
 * `null`; absent fields mean "unknown / not applicable".
 */
import { z } from 'zod';

export const PROTOCOL_VERSION = 1;

/** CC: Tweaked's default per-message websocket limit is 128 KiB; we stay well below it. */
export const MAX_MESSAGE_BYTES = 64 * 1024;
export const MAX_OBSERVATIONS_PER_MESSAGE = 256;
export const MAX_RECENT_RESULTS = 16;
export const HEARTBEAT_INTERVAL_MS = 5_000;
/** No heartbeat for this long: the turtle is shown as stale. */
export const STALE_AFTER_MS = 12_000;
/** No heartbeat for this long: the server drops the socket and the turtle is offline. */
export const OFFLINE_AFTER_MS = 30_000;
/** Per-turtle bound on queued manual commands. */
export const MAX_QUEUED_COMMANDS = 16;
export const DEFAULT_COMMAND_TTL_MS = 30_000;
/** A dispatched command with no result after this long gets the outcome `unknown`. */
export const COMMAND_RESULT_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------- primitives

/** Lua encodes empty arrays as `{}`; accept that wherever an array is expected. */
export const luaArray = <T extends z.ZodTypeAny>(item: T, max = 1000) =>
  z.preprocess(
    (v) => (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0 ? [] : v),
    z.array(item).max(max),
  );

const int = () => z.number().int();
const id = () => z.string().min(1).max(64);

export const Vec3 = z.object({ x: int(), y: int(), z: int() });
export type Vec3 = z.infer<typeof Vec3>;

/** Minecraft facing: 0 north (-Z), 1 east (+X), 2 south (+Z), 3 west (-X). */
export const Heading = int().min(0).max(3);
export type Heading = 0 | 1 | 2 | 3;
export const HEADING_NAMES = ['north', 'east', 'south', 'west'] as const;
export const HEADING_VECTORS: ReadonlyArray<{ x: number; z: number }> = [
  { x: 0, z: -1 },
  { x: 1, z: 0 },
  { x: 0, z: 1 },
  { x: -1, z: 0 },
];

export const Confidence = z.enum(['known', 'uncertain', 'unknown']);
export type Confidence = z.infer<typeof Confidence>;

/** Where the current belief came from. `tracked` = dead reckoning after confirmed moves. */
export const PoseSource = z.enum(['manual', 'gps', 'tracked', 'none']);

export const Pose = z.object({
  pos: Vec3.optional(),
  heading: Heading.optional(),
  position: Confidence,
  headingConfidence: Confidence,
  source: PoseSource,
  /** When `position` is uncertain: the cells the turtle might physically be in. */
  candidates: luaArray(Vec3).optional(),
});
export type Pose = z.infer<typeof Pose>;

export const Fuel = z.union([int().min(0), z.literal('unlimited')]);
export type Fuel = z.infer<typeof Fuel>;

export const Item = z.object({ slot: int().min(1).max(16), name: z.string().max(128), count: int().min(0).max(64) });
export type Item = z.infer<typeof Item>;

/** What the turtle is doing, as reported by the agent. Connection state is tracked by the server. */
export const Activity = z.enum(['idle', 'working', 'paused', 'unloading', 'returning', 'blocked', 'error']);
export type Activity = z.infer<typeof Activity>;

export type Connection = 'online' | 'stale' | 'offline';
/** What the dashboard shows: connection problems take precedence over activity. */
export type DisplayStatus = 'offline' | 'stale' | Activity;

export const StopReason = z.enum(['estop', 'pause']);
export type StopReason = z.infer<typeof StopReason>;

export const Hold = z.object({ stopId: id(), reason: StopReason });
export type Hold = z.infer<typeof Hold>;

export const ErrorInfo = z.object({ code: z.string().max(32), message: z.string().max(256), at: int().optional() });
export type ErrorInfo = z.infer<typeof ErrorInfo>;

/** Peripheral types of the turtle's left/right upgrades (absent = tool or nothing). */
export const Upgrades = z.object({ left: z.string().max(64).optional(), right: z.string().max(64).optional() });
export type Upgrades = z.infer<typeof Upgrades>;

/** Advanced Peripherals' Chunk Controller upgrade shows up as this peripheral type. */
export const CHUNKY_PERIPHERAL = 'chunky';

export function hasChunkLoader(u: Upgrades | undefined): boolean {
  return !!u && (u.left === CHUNKY_PERIPHERAL || u.right === CHUNKY_PERIPHERAL);
}

export const TurtleState = z.object({
  pose: Pose,
  fuel: Fuel,
  fuelLimit: Fuel,
  selectedSlot: int().min(1).max(16),
  inventory: luaArray(Item),
  activity: Activity,
  hold: Hold.optional(),
  currentCommandId: id().optional(),
  lastError: ErrorInfo.optional(),
  upgrades: Upgrades.optional(),
});
export type TurtleState = z.infer<typeof TurtleState>;

// ---------------------------------------------------------------- operations

const NoArgs = z.object({}).strict();
/** Which neighbouring block an inventory op acts on. */
export const Dir = z.enum(['front', 'up', 'down']);
export type Dir = z.infer<typeof Dir>;
/** `force` skips the name-based protection list, but never allows digging an inventory. */
const DigArgs = z.object({ force: z.boolean().optional() }).strict();

/**
 * The complete set of operations a turtle will run. There is deliberately no
 * "eval" or "run program" operation: the server can only ask for these.
 */
export const OpArgs = {
  forward: NoArgs,
  back: NoArgs,
  up: NoArgs,
  down: NoArgs,
  turnLeft: NoArgs,
  turnRight: NoArgs,
  dig: DigArgs,
  digUp: DigArgs,
  digDown: DigArgs,
  inspect: NoArgs,
  inspectUp: NoArgs,
  inspectDown: NoArgs,
  select: z.object({ slot: int().min(1).max(16) }).strict(),
  refuel: z.object({ count: int().min(0).max(64).optional() }).strict(),
  /** Manual calibration: the operator states where the turtle is and which way it faces. */
  calibrate: z.object({ x: int(), y: int(), z: int(), heading: Heading }).strict(),
  /** gps.locate(); fixes position only, never heading. */
  gpsLocate: z.object({ timeout: z.number().min(0.5).max(5).optional() }).strict(),
  setLabel: z.object({ label: z.string().min(1).max(32) }).strict(),
  /**
   * Verified drop of one slot into an adjacent INVENTORY. The agent refuses when the
   * side is not an inventory peripheral, so items are never thrown into the world.
   */
  drop: z.object({ dir: Dir, slot: int().min(1).max(16), count: int().min(1).max(64).optional() }).strict(),
  /** Take items from an adjacent inventory (never from the world) into `slot` and onwards. */
  suck: z.object({ dir: Dir, slot: int().min(1).max(16), count: int().min(1).max(64).optional() }).strict(),
  /** Describe an adjacent inventory: size, used slots, item totals. */
  inventoryInfo: z.object({ dir: Dir }).strict(),
} as const;
export type Op = keyof typeof OpArgs;
export const OPS = Object.keys(OpArgs) as Op[];
export type ArgsOf<O extends Op> = z.infer<(typeof OpArgs)[O]>;

export const MOVE_OPS: ReadonlySet<Op> = new Set(['forward', 'back', 'up', 'down']);
export const TURN_OPS: ReadonlySet<Op> = new Set(['turnLeft', 'turnRight']);
export const DIG_OPS: ReadonlySet<Op> = new Set(['dig', 'digUp', 'digDown']);
/** Operations refused while a turtle is held (paused or emergency-stopped). */
export const PHYSICAL_OPS: ReadonlySet<Op> = new Set([...MOVE_OPS, ...TURN_OPS, ...DIG_OPS, 'refuel', 'drop', 'suck']);

/** Normalised failure codes. Agents also pass CC's raw reason string. */
export const ErrorCode = z.enum([
  'obstructed',
  'out_of_fuel',
  'unbreakable',
  'nothing_to_dig',
  'protected',
  'busy',
  'held',
  'expired',
  'invalid',
  'no_gps',
  'pose_unknown',
  'no_inventory',
  'inventory_full',
  'unverified',
  'failed',
  'internal',
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

/** Map a CC: Tweaked failure reason string to an ErrorCode. Unknown strings map to `failed`. */
export function classifyReason(reason: string | undefined): ErrorCode {
  const r = (reason ?? '').toLowerCase();
  if (r.includes('obstructed')) return 'obstructed';
  if (r.includes('out of fuel')) return 'out_of_fuel';
  if (r.includes('unbreakable')) return 'unbreakable';
  if (r.includes('nothing to dig')) return 'nothing_to_dig';
  if (r.includes('protected')) return 'protected';
  return 'failed';
}

// ---------------------------------------------------------------- envelopes

const env = {
  v: z.literal(PROTOCOL_VERSION),
  id: id(),
  ts: z.number(),
};

export const Agent = z.object({ kind: z.enum(['lua', 'sim']), version: z.string().max(32) });

export const RecentResult = z.object({
  commandId: id(),
  /** `running` = started but never finished (e.g. rebooted mid-operation). */
  status: z.enum(['running', 'succeeded', 'failed', 'cancelled', 'rejected', 'unknown']),
});
export type RecentResult = z.infer<typeof RecentResult>;

export const BlockObservation = z.object({
  x: int(),
  y: int(),
  z: int(),
  /** Absent = observed air (nothing there). */
  name: z.string().max(128).optional(),
  state: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
});
export type BlockObservation = z.infer<typeof BlockObservation>;

// ---- turtle -> server

export const EnrollMsg = z.object({
  ...env,
  type: z.literal('enroll'),
  code: z.string().min(4).max(32),
  computerId: int().min(0),
  label: z.string().max(32).optional(),
  agent: Agent,
});

export const HelloMsg = z.object({
  ...env,
  type: z.literal('hello'),
  turtleId: id(),
  secret: z.string().min(16).max(128),
  computerId: int().min(0),
  label: z.string().max(32).optional(),
  agent: Agent,
  /** Random per boot; lets the server tell a reboot from a reconnect. */
  bootId: id(),
  /** The agent's persisted record of recent commands, used to reconcile `unknown` outcomes. */
  recent: luaArray(RecentResult, MAX_RECENT_RESULTS),
});

export const SnapshotMsg = z.object({ ...env, type: z.literal('snapshot'), state: TurtleState });
export const TelemetryMsg = z.object({ ...env, type: z.literal('telemetry'), state: TurtleState.partial() });
export const HeartbeatMsg = z.object({ ...env, type: z.literal('hb'), seq: int(), fuel: Fuel.optional() });

export const AckMsg = z.object({
  ...env,
  type: z.literal('ack'),
  commandId: id(),
  status: z.enum(['accepted', 'rejected', 'duplicate']),
  code: ErrorCode.optional(),
  reason: z.string().max(256).optional(),
});

export const ResultMsg = z.object({
  ...env,
  type: z.literal('result'),
  commandId: id(),
  status: z.enum(['succeeded', 'failed', 'cancelled']),
  code: ErrorCode.optional(),
  /** Raw failure reason from CC: Tweaked, if any. */
  reason: z.string().max(256).optional(),
  /** Op-specific data, e.g. the inspected block. */
  data: z.record(z.unknown()).optional(),
  /** True when this is a cached result re-sent for a duplicate delivery. */
  duplicate: z.boolean().optional(),
  state: TurtleState.partial().optional(),
});

export const StopAckMsg = z.object({
  ...env,
  type: z.literal('stop_ack'),
  stopId: id(),
  /** The atomic operation still finishing, if any. The turtle stops after it. */
  finishing: id().optional(),
});
export const ReleasedMsg = z.object({ ...env, type: z.literal('released'), stopId: id() });

export const ObserveMsg = z.object({
  ...env,
  type: z.literal('observe'),
  blocks: luaArray(BlockObservation, MAX_OBSERVATIONS_PER_MESSAGE),
});

export const LogMsg = z.object({
  ...env,
  type: z.literal('log'),
  level: z.enum(['info', 'warn', 'error']),
  message: z.string().max(256),
});

export const TurtleToServer = z.discriminatedUnion('type', [
  EnrollMsg,
  HelloMsg,
  SnapshotMsg,
  TelemetryMsg,
  HeartbeatMsg,
  AckMsg,
  ResultMsg,
  StopAckMsg,
  ReleasedMsg,
  ObserveMsg,
  LogMsg,
]);
export type TurtleToServer = z.infer<typeof TurtleToServer>;

// ---- server -> turtle (plain types; turtles validate these themselves)

interface Env {
  v: typeof PROTOCOL_VERSION;
  id: string;
  ts: number;
}
export interface WelcomeMsg extends Env {
  type: 'welcome';
  turtleId: string;
  name: string;
  serverTime: number;
  heartbeatMs: number;
  config: { scanOnMove: boolean; protectedBlocks: string[] };
}
export interface EnrolledMsg extends Env {
  type: 'enrolled';
  turtleId: string;
  secret: string;
  name: string;
}
export interface DeniedMsg extends Env {
  type: 'denied';
  reason: string;
}
export interface CmdMsg extends Env {
  type: 'cmd';
  commandId: string;
  op: Op;
  args: Record<string, unknown>;
  /** Server epoch ms after which the turtle must refuse to start the command. */
  expiresAt: number;
  executor: string;
}
export interface CancelMsg extends Env {
  type: 'cancel';
  commandId: string;
}
export interface StopMsg extends Env {
  type: 'stop';
  stopId: string;
  reason: StopReason;
}
export interface ReleaseMsg extends Env {
  type: 'release';
  stopId: string;
}
export interface HbAckMsg extends Env {
  type: 'hb_ack';
  seq: number;
}
export type ServerToTurtle = WelcomeMsg | EnrolledMsg | DeniedMsg | CmdMsg | CancelMsg | StopMsg | ReleaseMsg | HbAckMsg;

// ---------------------------------------------------------------- dashboard API types

export type CommandStatus =
  | 'queued'
  | 'sent'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'rejected'
  | 'expired'
  /** Turtle was offline; nothing was delivered. */
  | 'undeliverable'
  /** Delivered, but the result never arrived (connection lost). Reconciled on reconnect when possible. */
  | 'unknown';

export const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  'succeeded',
  'failed',
  'cancelled',
  'rejected',
  'expired',
  'undeliverable',
  'unknown',
]);

export type StopStatus = 'sent' | 'acknowledged' | 'stopped' | 'unreachable' | 'released';

export interface BatchItem {
  turtleId: string;
  commandId?: string;
  status: CommandStatus | StopStatus;
  code?: string;
  reason?: string;
  data?: Record<string, unknown>;
  updatedAt: number;
}

export interface BatchView {
  id: string;
  kind: 'command' | 'stop' | 'release' | 'cancel';
  op?: string;
  args?: Record<string, unknown>;
  label: string;
  createdAt: number;
  items: BatchItem[];
}

export interface TurtleView {
  id: string;
  name: string;
  label?: string;
  computerId: number;
  world: string;
  dimension: string;
  simulated: boolean;
  agentVersion?: string;
  connection: Connection;
  status: DisplayStatus;
  state?: TurtleState;
  queueLength: number;
  /** Stop requested while offline; delivered on reconnect. */
  pendingStop: boolean;
  /** The job controlling this turtle, if any. */
  job?: { id: string; name: string; status: JobStatus; phase: JobPhase };
  /** A one-off task such as "go to", if any. */
  /** A go-to in progress, with its planned route (next cells, for the map). */
  task?: { kind: 'goto'; target: Vec3; note?: string; route?: Vec3[] };
  lastSeen?: number;
  groupIds: string[];
  createdAt: number;
}

export interface GroupView {
  id: string;
  name: string;
  color: string;
  memberIds: string[];
}

export interface EventView {
  id: number;
  ts: number;
  level: 'info' | 'warn' | 'error';
  turtleId?: string;
  message: string;
}

export type MapCellState = 'empty' | 'solid' | 'fluid';
export interface MapBlock {
  x: number;
  y: number;
  z: number;
  /** null for observed air / traversed space. */
  block: string | null;
  cell: MapCellState;
  observedAt: number;
  source?: string;
}

export interface Targets {
  turtleIds?: string[];
  groupIds?: string[];
  all?: boolean;
}

export type UiServerMsg =
  | { type: 'init'; turtles: TurtleView[]; groups: GroupView[]; batches: BatchView[]; events: EventView[]; jobs: JobView[]; depots: DepotView[]; forcedChunks: ForcedChunk[] }
  | { type: 'turtle'; turtle: TurtleView }
  | { type: 'turtle_removed'; id: string }
  | { type: 'groups'; groups: GroupView[] }
  | { type: 'batch'; batch: BatchView }
  | { type: 'event'; event: EventView }
  | { type: 'map'; world: string; dimension: string; blocks: MapBlock[] }
  | { type: 'job'; job: JobView }
  | { type: 'job_removed'; id: string }
  | { type: 'depot'; depot: DepotView }
  | { type: 'depot_removed'; id: string }
  | { type: 'forced_chunks'; chunks: ForcedChunk[] }
  | { type: 'instances'; instances: InstanceView[] };

/** One Minecraft world/server ("save") and how much CC Fleet knows about it. */
export interface InstanceView {
  name: string;
  createdAt?: number;
  turtles: number;
  online: number;
  mapBlocks: number;
  /** Jobs not finished or cancelled. */
  jobs: number;
  depots: number;
  lastSeen?: number;
}

// ---------------------------------------------------------------- depots & jobs

/** Blocks the agent refuses to dig unless `force` is set (substring match on the block id). */
export const DEFAULT_PROTECTED_BLOCKS = ['chest', 'barrel', 'shulker_box', 'computercraft:', 'spawner', '_bed', 'portal', 'hopper', 'furnace'];

/** Items accepted as turtle fuel when deciding what to keep in the fuel slot. */
export const FUEL_ITEMS = new Set(['minecraft:coal', 'minecraft:charcoal', 'minecraft:coal_block', 'minecraft:blaze_rod', 'minecraft:lava_bucket']);

export const DepotInput = z.object({
  name: z.string().min(1).max(40),
  world: z.string().min(1).max(40),
  dimension: z.string().min(1).max(80),
  /** The cell the turtle stands in to use the depot. */
  dock: Vec3,
  /** The direction the turtle faces at the dock (matters when a chest is in front). */
  dockHeading: Heading,
  /** Where the unload chest is, relative to the docked turtle. */
  unloadDir: Dir,
  /** Optional fuel chest, relative to the docked turtle. Must differ from unloadDir. */
  fuelDir: Dir.optional(),
  /** Cells where turtles wait for the dock (used by multi-turtle queues, Milestone 4). */
  waiting: z.array(Vec3).max(16).default([]),
});
export type DepotInput = z.infer<typeof DepotInput>;
export interface DepotView extends DepotInput {
  id: string;
  /** Turtle currently using the dock (also kept while that turtle is offline). */
  lockedBy?: string;
  createdAt: number;
}

export const Box = z.object({ min: Vec3, max: Vec3 });
export type Box = z.infer<typeof Box>;

/**
 * Tunnel: clears every cell origin + d*forward + w*right + h*up for
 * 0<=d<length, 0<=w<width, 0<=h<height. The origin is the bottom-left cell of the
 * first slice when looking along `heading`.
 */
export const TunnelParams = z.object({
  origin: Vec3,
  heading: Heading,
  width: int().min(1).max(16),
  height: int().min(1).max(16),
  length: int().min(1).max(1024),
});
export type TunnelParams = z.infer<typeof TunnelParams>;

/**
 * Branch mine ("strip mining"): a main corridor (width x height x length) along
 * `heading`, with side branches every `spacing` blocks along it (spacing 3 leaves two
 * solid blocks between branches). Branches are 1 wide, as high as the corridor, and
 * `branchLength` long, on the left, right or both sides.
 */
export const BranchParams = z.object({
  origin: Vec3,
  heading: Heading,
  width: int().min(1).max(3),
  height: int().min(1).max(3),
  length: int().min(1).max(512),
  spacing: int().min(2).max(16),
  branchLength: int().min(1).max(64),
  sides: z.enum(['both', 'left', 'right']),
});
export type BranchParams = z.infer<typeof BranchParams>;

/**
 * Quarry: clear the box `width` (to the right) x `length` (along heading) x `depth`
 * (downwards). The origin is the top-left cell of the box's top layer, looking along
 * the heading. Mined top-down in layers of up to 3 blocks.
 */
export const QuarryParams = z.object({
  origin: Vec3,
  heading: Heading,
  width: int().min(1).max(64),
  length: int().min(1).max(64),
  depth: int().min(1).max(256),
});
export type QuarryParams = z.infer<typeof QuarryParams>;

/**
 * Grid mine: parallel 1-wide tunnels (`height` high, `length` long along the heading)
 * across an area `width` blocks wide (to the right), one every `spacing` blocks. Spacing
 * 3 leaves two solid columns between tunnels, so every block of the area touches a
 * tunnel (with wall scanning, every ore in it is seen). Mined back and forth: each
 * tunnel is joined to the next by a short passage at alternating ends.
 */
export const GridParams = z.object({
  origin: Vec3,
  heading: Heading,
  width: int().min(1).max(128),
  length: int().min(1).max(256),
  height: int().min(1).max(3),
  spacing: int().min(2).max(8),
});
export type GridParams = z.infer<typeof GridParams>;

export const StrategyInput = z.discriminatedUnion('strategy', [
  z.object({ strategy: z.literal('tunnel'), params: TunnelParams }),
  z.object({ strategy: z.literal('branch'), params: BranchParams }),
  z.object({ strategy: z.literal('quarry'), params: QuarryParams }),
  z.object({ strategy: z.literal('grid'), params: GridParams }),
]);
export type StrategyInput = z.infer<typeof StrategyInput>;
export type Strategy = StrategyInput['strategy'];

export const JobPolicy = z.object({
  /** Return to unload when this many (or fewer) unreserved slots are free. */
  minFreeSlots: int().min(0).max(14).default(1),
  /** Slot kept for fuel. Only fuel items are kept there; anything else is unloaded. 0 = none. */
  fuelSlot: int().min(0).max(16).default(16),
  /** Slots never unloaded (e.g. torches for later strategies). */
  keepSlots: z.array(int().min(1).max(16)).max(8).default([]),
  /** Extra fuel kept beyond the estimated cost of getting back to the dock. */
  fuelReserve: int().min(0).max(10000).default(100),
  /** Refuel up to this level at the depot (capped by the turtle's fuel limit). */
  refuelTarget: int().min(0).max(100000).default(2000),
  returnHomeWhenDone: z.boolean().default(true),
  /**
   * Opt-in: if the job paused because its turtle dropped, resume when the turtle comes
   * back (within 15 min, at most 3 times per hour, only with a known pose and no hold).
   */
  autoResume: z.boolean().default(false),
  /**
   * Look left and right at the edge of the work area as it goes, so the walls get
   * mapped (and ores in them seen). Turning costs no fuel but takes time.
   */
  scanWalls: z.boolean().default(false),
  /**
   * Follow ore veins: when a block whose id contains one of `ores` is seen near the work
   * area, mine the connected vein before continuing. Only matching ore blocks are ever
   * dug outside the work area. Empty = off.
   */
  veins: z
    .object({
      ores: z.array(z.string().min(2).max(64)).max(16).default([]),
      /** Max blocks mined per vein. */
      maxBlocks: int().min(1).max(256).default(48),
      /** How far (blocks) outside the work area a vein may be followed. */
      reach: int().min(1).max(16).default(6),
    })
    .default({}),
});
export type JobPolicy = z.infer<typeof JobPolicy>;

export const JobInput = z
  .object({
    name: z.string().min(1).max(60),
    depotId: z.string(),
    turtleId: z.string(),
    policy: JobPolicy.partial().default({}),
    /** Boxes that must never be dug, even inside the job volume. */
    exclusions: z.array(Box).max(32).default([]),
  })
  .and(StrategyInput);
export type JobInput = z.input<typeof JobInput>;

/**
 * Several jobs created together. Either explicit jobs (e.g. one tunnel in front of
 * each turtle) or one tunnel split into side-by-side lanes, one per turtle.
 * All jobs are validated before any is created.
 */
export const CampaignInput = z
  .object({
    name: z.string().min(1).max(60),
    depotId: z.string(),
    policy: JobPolicy.partial().default({}),
    start: z.boolean().default(false),
    jobs: z.array(z.object({ turtleId: z.string() }).and(StrategyInput)).min(1).max(64).optional(),
    /** One tunnel or quarry split side by side into one lane per turtle. */
    split: z
      .object({ turtleIds: z.array(z.string()).min(1).max(16) })
      .and(z.discriminatedUnion('strategy', [z.object({ strategy: z.literal('tunnel'), params: TunnelParams }), z.object({ strategy: z.literal('quarry'), params: QuarryParams })]))
      .optional(),
  })
  .refine((c) => !!c.jobs !== !!c.split, 'give either jobs or split');
export type CampaignInput = z.input<typeof CampaignInput>;

/**
 * A chunk the operator says is kept loaded by something CC Fleet can't see (e.g. FTB
 * Chunks force-loading). A Chunk Controller only keeps the turtle's own chunk active:
 * a turtle that steps into a chunk nothing else keeps loaded stops.
 */
export interface ForcedChunk {
  world: string;
  dimension: string;
  cx: number;
  cz: number;
  createdAt: number;
}

/** Chunks a job will need, and whether each is marked as force-loaded. */
export interface ChunkNeed {
  cx: number;
  cz: number;
  forced: boolean;
}

export type JobStatus = 'ready' | 'running' | 'pausing' | 'paused' | 'completed' | 'cancelled';
export type JobPhase = 'idle' | 'traveling' | 'mining' | 'waiting' | 'returning' | 'unloading' | 'refueling' | 'done';

export interface JobEstimate {
  moves: number;
  fuel: number;
  seconds: number;
  trips: number;
  cells: number;
  /** Always shown with the numbers: these are estimates, not plans. */
  note: string;
}

export interface JobView {
  id: string;
  name: string;
  strategy: Strategy;
  params: TunnelParams | BranchParams | QuarryParams | GridParams;
  /** The work volume as plain tunnel sections, in mining order (see segmentsFor). */
  segments: TunnelParams[];
  policy: JobPolicy;
  exclusions: Box[];
  world: string;
  dimension: string;
  depotId: string;
  turtleId: string;
  /** Set when the job was created as part of a campaign (several turtles at once). */
  campaignId?: string;
  campaignName?: string;
  /** For split tunnels: which lane of how many. */
  lane?: { index: number; count: number };
  status: JobStatus;
  phase: JobPhase;
  pauseReason?: string;
  /** Live detail for the operator, e.g. what the turtle is waiting for. */
  note?: string;
  error?: { code: string; message: string; at: number };
  progress: {
    unitsDone: number;
    unitsTotal: number;
    cellsCleared: number;
    cellsSkipped: number;
    trips: number;
    itemsUnloaded: number;
    /** Ore blocks mined, by block id. */
    finds?: Record<string, number>;
    /** Ore blocks mined by following veins outside the work area. */
    veinBlocks?: number;
  };
  estimate: JobEstimate;
  /** Next cells on the turtle's planned route (for the map). */
  route?: Vec3[];
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  finishedAt?: number;
}

// ---------------------------------------------------------------- helpers

export const FLUID_BLOCKS = new Set(['minecraft:water', 'minecraft:lava', 'minecraft:flowing_water', 'minecraft:flowing_lava']);

export function stepFor(op: Op, heading: Heading): Vec3 | undefined {
  const h = HEADING_VECTORS[heading];
  switch (op) {
    case 'forward':
      return { x: h.x, y: 0, z: h.z };
    case 'back':
      return { x: -h.x || 0, y: 0, z: -h.z || 0 };
    case 'up':
      return { x: 0, y: 1, z: 0 };
    case 'down':
      return { x: 0, y: -1, z: 0 };
    default:
      return undefined;
  }
}

export function addVec(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

export function turned(heading: Heading, op: 'turnLeft' | 'turnRight'): Heading {
  return (((heading + (op === 'turnRight' ? 1 : 3)) % 4) as Heading);
}

/** Validate op arguments; returns parsed args or an error message. */
export function parseOpArgs(op: string, args: unknown): { ok: true; args: Record<string, unknown> } | { ok: false; error: string } {
  if (!(op in OpArgs)) return { ok: false, error: `unknown operation "${op}"` };
  const raw = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  const r = OpArgs[op as Op].safeParse(raw);
  return r.success ? { ok: true, args: r.data as Record<string, unknown> } : { ok: false, error: r.error.issues[0]?.message ?? 'invalid arguments' };
}

/** Parse and validate one raw frame from a turtle. */
export function parseTurtleMessage(raw: string): { ok: true; msg: TurtleToServer } | { ok: false; error: string } {
  if (raw.length > MAX_MESSAGE_BYTES) return { ok: false, error: 'message too large' };
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'invalid JSON' };
  }
  if (json && typeof json === 'object' && 'v' in json && (json as { v: unknown }).v !== PROTOCOL_VERSION) {
    return { ok: false, error: `unsupported protocol version ${(json as { v: unknown }).v}` };
  }
  const r = TurtleToServer.safeParse(json);
  if (!r.success) {
    const i = r.error.issues[0];
    return { ok: false, error: `invalid message: ${i?.path.join('.')} ${i?.message}` };
  }
  return { ok: true, msg: r.data };
}

// ---------------------------------------------------------------- strategies -> segments

/**
 * Every strategy is expressed as an ordered list of plain tunnel sections. Mining goes
 * section by section, slice by slice; a "unit" (the checkpoint granularity) is one slice
 * of one section.
 */
export function segmentsFor(s: StrategyInput): TunnelParams[] {
  if (s.strategy === 'tunnel') return [s.params];
  if (s.strategy === 'quarry') {
    const p = s.params;
    const out: TunnelParams[] = [];
    let top = p.origin.y;
    let left = p.depth;
    while (left > 0) {
      const h = Math.min(3, left);
      out.push({ origin: { x: p.origin.x, y: top - h + 1, z: p.origin.z }, heading: p.heading, width: p.width, height: h, length: p.length });
      top -= h;
      left -= h;
    }
    return out;
  }
  if (s.strategy === 'grid') return gridSegments(s.params);
  const p = s.params;
  const f = HEADING_VECTORS[p.heading];
  const r = HEADING_VECTORS[(p.heading + 1) % 4];
  const cell = (d: number, w: number) => ({ x: p.origin.x + f.x * d + r.x * w, y: p.origin.y, z: p.origin.z + f.z * d + r.z * w });
  const out: TunnelParams[] = [];
  let start = 0;
  for (let d = p.spacing; d < p.length; d += p.spacing) {
    out.push({ origin: cell(start, 0), heading: p.heading, width: p.width, height: p.height, length: d - start + 1 });
    if (p.sides !== 'right') {
      const c = cell(d, 0);
      const l = HEADING_VECTORS[(p.heading + 3) % 4];
      out.push({ origin: { x: c.x + l.x, y: c.y, z: c.z + l.z }, heading: ((p.heading + 3) % 4) as Heading, width: 1, height: p.height, length: p.branchLength });
    }
    if (p.sides !== 'left') {
      const c = cell(d, p.width - 1);
      out.push({ origin: { x: c.x + r.x, y: c.y, z: c.z + r.z }, heading: ((p.heading + 1) % 4) as Heading, width: 1, height: p.height, length: p.branchLength });
    }
    start = d + 1;
  }
  if (start < p.length) out.push({ origin: cell(start, 0), heading: p.heading, width: p.width, height: p.height, length: p.length - start });
  return out;
}

function gridSegments(p: GridParams): TunnelParams[] {
  const f = HEADING_VECTORS[p.heading];
  const r = HEADING_VECTORS[(p.heading + 1) % 4];
  const cell = (d: number, w: number) => ({ x: p.origin.x + f.x * d + r.x * w, y: p.origin.y, z: p.origin.z + f.z * d + r.z * w });
  const back = ((p.heading + 2) % 4) as Heading;
  const right = ((p.heading + 1) % 4) as Heading;
  const out: TunnelParams[] = [];
  for (let k = 0, w = 0; w < p.width; k++, w += p.spacing) {
    const forward = k % 2 === 0;
    out.push({ origin: cell(forward ? 0 : p.length - 1, w), heading: forward ? p.heading : back, width: 1, height: p.height, length: p.length });
    // Passage to the next tunnel, at the end we're at.
    if (w + p.spacing < p.width && p.spacing > 1) {
      out.push({ origin: cell(forward ? p.length - 1 : 0, w + 1), heading: right, width: 1, height: p.height, length: p.spacing - 1 });
    }
  }
  return out;
}

/** Axis-aligned bounding box of a tunnel section. */
export function sectionBox(p: TunnelParams): Box {
  const f = HEADING_VECTORS[p.heading];
  const r = HEADING_VECTORS[(p.heading + 1) % 4];
  const end = { x: p.origin.x + f.x * (p.length - 1) + r.x * (p.width - 1), z: p.origin.z + f.z * (p.length - 1) + r.z * (p.width - 1) };
  return {
    min: { x: Math.min(p.origin.x, end.x), y: p.origin.y, z: Math.min(p.origin.z, end.z) },
    max: { x: Math.max(p.origin.x, end.x), y: p.origin.y + p.height - 1, z: Math.max(p.origin.z, end.z) },
  };
}

/** Does a block id look like an ore (vanilla or modded)? */
export function isOreBlock(name: string | null | undefined): boolean {
  if (!name) return false;
  const w = idWords(name);
  return w.includes('ore') || w.includes('ores') || name.toLowerCase().endsWith(':ancient_debris');
}

/** Words of a block id's path: "emendatusenigmatica:coal_ore" -> ["coal", "ore"]. */
function idWords(id: string): string[] {
  const path = id.toLowerCase().split(':').pop() ?? '';
  return path.split(/[/_\-.\s]+/).filter(Boolean);
}

const ANY_ORE = new Set(['_ore', 'ore', 'ores', 'any', 'any_ore', '*']);

/**
 * Does a vein filter match this block? Case-insensitive and mod-agnostic:
 * - "any" / "_ore": any ore block (an id with the word "ore" or "ores", or ancient debris);
 * - "coal", "coal_ore", "Coal Ore": an ore whose id has the word "coal"
 *   (minecraft:coal_ore, emendatusenigmatica:coal_ore, x:deepslate_coal_ore, x:ore_coal);
 * - "mod:block": that exact block id;
 * - any other word: a block whose id path is exactly that ("obsidian").
 */
export function oreMatches(filter: string, name: string | null | undefined): boolean {
  if (!name) return false;
  const f = filter.trim().toLowerCase().replace(/\s+/g, '_');
  const id = name.toLowerCase();
  if (!f) return false;
  if (ANY_ORE.has(f)) return isOreBlock(id);
  if (f.includes(':')) return id === f;
  if (!isOreBlock(id)) return id.split(':').pop() === f;
  const want = idWords(f).filter((w) => w !== 'ore' && w !== 'ores');
  if (!want.length) return true;
  const have = new Set(idWords(id));
  return want.every((w) => have.has(w));
}

/** Common ore filters for vein following (see oreMatches). */
export const ORE_PRESETS: { label: string; match: string }[] = [
  { label: 'Diamond', match: 'diamond_ore' },
  { label: 'Emerald', match: 'emerald_ore' },
  { label: 'Gold', match: 'gold_ore' },
  { label: 'Iron', match: 'iron_ore' },
  { label: 'Redstone', match: 'redstone_ore' },
  { label: 'Lapis', match: 'lapis_ore' },
  { label: 'Coal', match: 'coal_ore' },
  { label: 'Ancient debris', match: 'ancient_debris' },
  { label: 'Any ore', match: '_ore' },
];
