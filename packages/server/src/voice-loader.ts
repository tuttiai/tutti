/**
 * Turning `TUTTI_VOICES` into the voices one agent holds.
 *
 * Three rules, each refusing rather than guessing, because the alternative in
 * every case is an agent holding something other than what it was granted:
 *
 * - **An unknown voice is refused**, listing the voices this image carries.
 * - **Options are validated by the voice's own schema**, and a refusal names
 *   the field and the kind of problem, never the value.
 * - **`only` narrows the tools, and an unknown tool name in it is refused.** A
 *   typo in an allowlist is a grant nobody meant, in one direction or the other.
 */

import { z } from "zod";
import type { Tool, Voice } from "@tuttiai/types";

import { VOICE_LOADERS, type VoiceBuilder, type VoiceLoader } from "./voice-registry.js";

/** One voice as `TUTTI_VOICES` carries it. */
export const VoiceSpecSchema = z
  .object({
    /** Registry key, such as `github`. */
    voice: z.string().min(1),
    /** Options for the voice's constructor, credentials included. Validated by the voice. */
    options: z.record(z.unknown()).default({}),
    /** Tools to keep. Absent means every tool the voice has. */
    only: z.array(z.string().min(1)).min(1).optional(),
  })
  .strict();

/** One voice as `TUTTI_VOICES` carries it. */
export type VoiceSpec = z.infer<typeof VoiceSpecSchema>;

/** Every voice for the agent. A ceiling, not a product rule. */
export const VoiceSpecsSchema = z.array(VoiceSpecSchema).max(32);

/** Why a voice could not be loaded. The message never carries an option's value. */
export class VoiceConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VoiceConfigError";
  }
}

/**
 * Keep only the named tools of a voice.
 *
 * @param voice - The voice to narrow.
 * @param only - The tool names to keep. Every one must exist on the voice.
 * @returns A voice with the same lifecycle and fewer tools.
 * @throws {VoiceConfigError} When a name is not one of the voice's tools.
 */
export function narrowVoice(voice: Voice, only: readonly string[]): Voice {
  const names = new Set(voice.tools.map((tool) => tool.name));
  const unknown = only.filter((name) => !names.has(name));
  if (unknown.length > 0) {
    throw new VoiceConfigError(
      `Voice "${voice.name}" has no tool named ${unknown.map((n) => `"${n}"`).join(", ")}.\n` +
        `Its tools are: ${[...names].join(", ")}.`,
    );
  }
  const keep = new Set(only);
  const tools: Tool[] = voice.tools.filter((tool) => keep.has(tool.name));
  const narrowed: Voice = {
    name: voice.name,
    tools,
    required_permissions: voice.required_permissions,
  };
  if (voice.description !== undefined) narrowed.description = voice.description;
  if (voice.setup !== undefined) narrowed.setup = voice.setup.bind(voice);
  if (voice.teardown !== undefined) narrowed.teardown = voice.teardown.bind(voice);
  return narrowed;
}

/** Load one spec's builder, turning a missing key or package into a clear refusal. */
async function builderFor(
  spec: VoiceSpec,
  loaders: ReadonlyMap<string, VoiceLoader>,
): Promise<VoiceBuilder> {
  const load = loaders.get(spec.voice);
  if (load === undefined) {
    throw new VoiceConfigError(
      `Unknown voice "${spec.voice}". This image carries: ${[...loaders.keys()].join(", ")}.`,
    );
  }
  try {
    return await load();
  } catch {
    throw new VoiceConfigError(`Voice "${spec.voice}" is not installed in this image.`);
  }
}

/**
 * Build every voice one agent holds.
 *
 * @param specs - The parsed `TUTTI_VOICES` list.
 * @param loaders - The registry. Injected in tests.
 * @returns The voices, narrowed where a spec says `only`.
 * @throws {VoiceConfigError} On an unknown or repeated voice, refused options, or an unknown tool.
 *
 * @example
 * const voices = await loadVoices([{ voice: "web", options: {} }]);
 */
export async function loadVoices(
  specs: readonly VoiceSpec[],
  loaders: ReadonlyMap<string, VoiceLoader> = VOICE_LOADERS,
): Promise<Voice[]> {
  const seen = new Set<string>();
  const voices: Voice[] = [];
  for (const spec of specs) {
    // Two copies of one voice would register every tool name twice.
    if (seen.has(spec.voice)) {
      throw new VoiceConfigError(`Voice "${spec.voice}" is listed more than once.`);
    }
    seen.add(spec.voice);

    const built = (await builderFor(spec, loaders))(spec.options);
    if (!built.ok) {
      const fields = built.issues.map((issue) => `${issue.path} (${issue.code})`).join(", ");
      throw new VoiceConfigError(`Voice "${spec.voice}" refused its options: ${fields}.`);
    }
    voices.push(spec.only === undefined ? built.voice : narrowVoice(built.voice, spec.only));
  }
  return voices;
}
