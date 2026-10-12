/**
 * Pi's own packages, as the embedded scripted provider (spikes/pi/lib/scripted-provider.ts)
 * imports them. Pi resolves them for an extension at load time; this repo does not install
 * them, so the type checker sees only these loose shapes (src/contracts/pi-profile.ts embeds it).
 */
declare module "@earendil-works/pi-ai" {
  // oxlint-disable-next-line typescript/no-explicit-any
  export type AssistantMessage = any;
  export function createAssistantMessageEventStream(): { push(event: unknown): void; end(): void };
  export function getCurrentTools(messages: unknown[]): unknown[] | undefined;
}

declare module "@earendil-works/pi-coding-agent" {
  export interface ExtensionAPI {
    registerProvider(name: string, config: Record<string, unknown>): void;
  }
}
