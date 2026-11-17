import { z } from 'zod';

const Bind = z.object({ node: z.string(), input: z.string() });
const Loader = z.object({
  class_type: z.string(),
  input: z.string(),
  /** Extra inputs set on every loader node we add (values or [nodeId, outputIndex] links). */
  fixed: z.record(z.string(), z.unknown()).optional(),
  /** Nodes added after the loader, each fed by the previous one's output 0 (e.g. split a video into frames and sound, or resize a picture). Links come from the last one. */
  then: z.array(z.object({ class_type: z.string(), input: z.string(), fixed: z.record(z.string(), z.unknown()).optional() })).optional(),
  /** which output of the last node feeds the target (default 0) */
  output: z.number().int().optional(),
});
const Base = { id: z.string().regex(/^[a-z0-9_]+$/), label: z.string().optional(), role: z.string().optional(), note: z.string().optional(),
  /** Set once in Settings → ComfyUI (a default for every generation); the Generate form shows it folded under "Advanced". */
  advanced: z.boolean().optional() };
/** Model kinds a loader slot can pick from; the files come live from ComfyUI's own loader list. */
export const MODEL_KINDS = ['unet', 'clip', 'vae', 'lora', 'checkpoint'] as const;

export const Slot = z.discriminatedUnion('type', [
  z.object({ ...Base, type: z.literal('text'), bind: z.array(Bind).min(1), default: z.string().optional(), required: z.boolean().optional(), promptGuide: z.string().optional() }),
  z.object({ ...Base, type: z.literal('number'), bind: z.array(Bind).min(1), /** inputs that get the value with its sign flipped (e.g. a frame index counted from the end) */ bindNegative: z.array(Bind).optional(), default: z.number().optional(), min: z.number().optional(), max: z.number().optional(), integer: z.boolean().optional() }),
  z.object({ ...Base, type: z.literal('enum'), bind: z.array(Bind).min(1), options: z.array(z.string()).optional(), default: z.string().optional(),
    /** A model file choice: options are the files ComfyUI has for this kind; `family` (a regex) lists the matching ones first. */
    model: z.enum(MODEL_KINDS).optional(), family: z.string().optional(),
    /** A node whose outputs 0 and 1 are width and height (e.g. ResolutionSelector): custom_width/custom_height replace it with fixed numbers. */
    customSize: z.object({ node: z.string() }).optional() }),
  z.object({
    ...Base, type: z.literal('boolean'), default: z.boolean().default(false),
    /** Nodes to delete from the graph when the toggle is off / on. */
    off: z.object({ remove: z.array(z.string()).default([]), /** inputs to delete from a node */ unset: z.array(Bind).default([]), /** pass-through nodes to cut out (consumers read the node's own input) */ bypass: z.array(Bind).default([]) }).optional(),
    on: z.object({ remove: z.array(z.string()).default([]), unset: z.array(Bind).default([]), bypass: z.array(Bind).default([]) }).optional(),
    /** Only offered when ComfyUI has these node classes (an optional speed-up). Without them the toggle stays off. */
    needsNodes: z.array(z.string()).optional(),
  }),
  z.object({
    ...Base, type: z.literal('image'), required: z.boolean().optional(),
    /** Existing loader node: set its image input. */
    bind: z.array(Bind).optional(),
    /** Or: add a loader node and link it to a node input (for optional inputs absent from the saved graph). */
    addNode: z.object({ class_type: z.string(), input: z.string(), fixed: z.record(z.string(), z.unknown()).optional(), linkTo: Bind }).optional(),
    /** When no picture is given: pass-through nodes to cut out and nodes to delete (same as for a video slot). */
    whenAbsent: z.object({ bypass: z.array(Bind).default([]), remove: z.array(z.string()).default([]) }).optional(),
  }),
  z.object({
    ...Base, type: z.literal('image_list'), min: z.number().int().default(0), max: z.number().int(),
    autogrow: z.object({ node: z.string(), inputPrefix: z.string(), loaderTemplate: Loader }),
  }),
  z.object({
    ...Base, type: z.literal('video'), required: z.boolean().optional(),
    /** The loader node(s) whose file input takes the uploaded clip. */
    bind: z.array(Bind).min(1),
    /** When no clip is given: pass-through nodes to cut out (consumers get the node's own input instead) and nodes to delete. */
    whenAbsent: z.object({ bypass: z.array(Bind).default([]), remove: z.array(z.string()).default([]) }).optional(),
  }),
  z.object({ ...Base, type: z.literal('video_list'), min: z.number().int().default(0), max: z.number().int(),
    autogrow: z.object({ node: z.string(), inputPrefix: z.string(), loaderTemplate: Loader,
      /** the clip's soundtrack goes to a second numbered input of the same node (output index of the loader that carries the audio) */
      audioPrefix: z.string().optional(), audioOutput: z.number().int().optional() }) }),
  z.object({ ...Base, type: z.literal('audio_list'), min: z.number().int().default(0), max: z.number().int(),
    autogrow: z.object({ node: z.string(), inputPrefix: z.string(), loaderTemplate: Loader }) }),
]);
export type Slot = z.infer<typeof Slot>;

export const Output = z.object({
  id: z.string(), type: z.enum(['image', 'video', 'audio']), node: z.string(),
  optional: z.boolean().optional(), kind: z.string().optional(), note: z.string().optional(),
});

export const Manifest = z.object({
  id: z.string().regex(/^[a-z0-9_-]+$/),
  version: z.number().int().positive(),
  title: z.string(),
  /** Path of the API-format workflow JSON, relative to the manifest. */
  workflow: z.string().default('workflow.json'),
  /** id of the guide file (guides/<id>.md) the LLM uses to write prompts for this model */
  guide: z.string().optional(),
  kind: z.enum(['image', 'video', 'audio']),
  outputHasAudio: z.boolean().optional(),
  frameGrid: z.object({ fps: z.number(), rule: z.string().optional(), note: z.string().optional() }).optional(),
  slots: z.array(Slot),
  /** How the LLM director should write for this model. */
  director: z.object({
    /** shot lengths worth asking for, seconds */
    seconds: z.array(z.number()).optional(),
    /** how many reference pictures a prompt may use */
    maxRefs: z.number().int().min(0).optional(),
    /** prompt guide file (markdown), relative to the manifest; overrides the short guide on the prompt slot */
    guideFile: z.string().optional(),
    /** the model always gets the shot's first frame as <Picture 1> (image-to-video) */
    firstFrame: z.boolean().optional(),
    lastFrame: z.boolean().optional(),
  }).optional(),
  outputs: z.array(Output).min(1),
  requires: z.object({
    nodeClasses: z.array(z.string()).default([]),
    /** Model kind -> file names. Kinds: unet, clip, vae, lora, checkpoint. */
    models: z.record(z.string(), z.array(z.string())).default({}),
  }).default({ nodeClasses: [], models: {} }),
});
export type Manifest = z.infer<typeof Manifest>;

export type ApiNode = { class_type: string; inputs: Record<string, unknown>; _meta?: unknown };
export type Graph = Record<string, ApiNode>;

export interface Profile { manifest: Manifest; workflow: Graph; dir: string; /** prompt guide text for the LLM director */ guide: string; /** shipped with the app, or from the user's own profiles folder */ source?: 'bundled' | 'user' }
