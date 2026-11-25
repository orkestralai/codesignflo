// Messages between the UI iframe (panel + WebSocket to the CLI) and the main thread (Figma API).
import type * as protocol from "@codesignflo/core/protocol";
import type { PanelState } from "./panel.js";

export type Context = {
  plugin: { version: string; dev: boolean };
  file: { name: string; projectId: string | null; editorType: string };
  user: { name: string | null } | null;
  savedSecret: string | null;
  /** The CoDesignFlo service (null: local mode only) and the saved sign-in, if any. */
  service: { url: string; anon: string; web: string; mode?: "cloud" | "selfhost" } | null;
  serviceSession: string | null;
  figmaUserId: string | null;
  /** The panel was folded down to its header last time. */
  collapsed: boolean;
  /** Getting-started progress per project (hidden, first claim, first send). */
  guide: Record<string, GuidePrefs>;
};

export type GuidePrefs = {
  hidden?: boolean;
  claimed?: boolean;
  sent?: boolean;
  /** The demo card put away ("Not now"): kept under the key "*", for every file. */
  demoHidden?: boolean;
  /** The guide's welcome card put away ("Not now"): a slim Guide line stays at the top instead. */
  introHidden?: boolean;
  /** The demo's walkthrough: the step reached, and whether it was closed or finished. */
  tour?: { step: number; closed?: boolean };
};

export type PanelAction =
  | "state"
  | "setUpFile"
  | "forgetProject"
  | "resetDemoFile"
  | "tourMark"
  | "demoShots"
  | "tourClear"
  | "answerReview"
  | "designNewMany"
  | "deleteRemoved"
  | "keepRemoved"
  | "scanDesigns"
  | "compareDesigns"
  | "designWins"
  | "decide"
  | "reviewInCode"
  | "useLive"
  | "finishBringingIn"
  | "acceptCode"
  | "keepDesign"
  | "unpin"
  | "preview"
  | "claim"
  | "ready"
  | "reopen"
  | "unclaim"
  | "seen"
  | "accept"
  | "ignore"
  | "show"
  | "designNew"
  | "adopt"
  | "thumbs"
  | "select"
  | "undo"
  | "dsState"
  | "dsCreate"
  | "dsAccept"
  | "dsMatch"
  | "dsUnlink"
  | "dsIgnore"
  | "dsReject"
  | "dsSetMap"
  | "dsLinkToken"
  | "dsRejectToken"
  | "dsSendNew";

export type UiToMain =
  | { kind: "getContext" }
  | { kind: "saveSecret"; secret: string | null }
  | { kind: "saveSession"; refreshToken: string | null }
  | { kind: "loadSession"; id: number }
  | { kind: "openExternal"; url: string }
  | { kind: "guide"; projectId: string; prefs: GuidePrefs }
  | { kind: "collapse"; collapsed: boolean }
  | { kind: "req"; msg: protocol.Request }
  | { kind: "panel"; id: number; action: PanelAction; params?: unknown };

export type MainToUi =
  | { kind: "session"; id: number; refreshToken: string | null }
  | { kind: "context"; context: Context }
  | { kind: "res"; msg: protocol.Response }
  | { kind: "progress"; msg: protocol.Progress }
  | { kind: "panelResult"; id: number; ok: true; result: unknown }
  | { kind: "panelResult"; id: number; ok: false; error: string }
  | { kind: "changed" }
  /** Design-side events just written to the file: the panel also sends them to the service. */
  | { kind: "cloudEvents"; events: unknown[] }
  /** A proposal sent to the developer: the panel uploads it to the service. */
  | { kind: "cloudProposal"; component: string; claim: string; payload: unknown }
  | { kind: "selection"; component?: string }
  /** Something changed on the page in view (the designer editing): the panel looks again if a copy is open. */
  | { kind: "edited" }
  | { kind: "reloadUi"; html: string };

export type { PanelState };
