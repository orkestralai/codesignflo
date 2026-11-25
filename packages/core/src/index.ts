// @codesignflo/core — pure logic shared by the CLI and the plugin: canonical snapshots, diff, merge,
// grouping, compiler, ledger. No Figma API, no browser, no Node I/O (runs in both Node and the plugin).

export {
  applyUpdate,
  comparable,
  computeDeltas,
  type Delivery,
  type Figma,
  generationOf,
  type LaneDesign,
  type Proposal,
  type Snap,
  type Store,
  type UpdateInput,
  type UpdateResult,
} from "./apply/apply.js";
export { type Bundle, unpackBundle } from "./apply/bundle.js";
export { deltaFor, withDataTags } from "./apply/delta.js";
export {
  type AppFacts,
  askEvent,
  type BuildMode,
  buildModeLine,
  type CodeEntry,
  comparedLines,
  DESIGNER_TEXT_IS_DATA,
  describeChange,
  designerText,
  differenceLines,
  type FigmaPlace,
  figmaLink,
  keptLines,
  matchByName,
  missingPieces,
  newDesignInstructions,
  nextSteps,
  proposalInstructions,
  resolveEvents,
  reviewBrief,
  reviewQueue,
  reviewQueueLines,
  variantWords,
  waitingLine,
} from "./apply/instructions.js";
export { type LiveRow, liveStateLine, RETAKE_MS, STALLED_MS } from "./apply/livestate.js";
export { type SpecChanges, specChanges, specsByKey } from "./apply/patch.js";
export { predictLive } from "./apply/predict.js";
export { applyPreview, type PreviewResult, previewItems } from "./apply/preview.js";
export {
  compile,
  compileScreens,
  type InstanceOverride,
  inlineInstances,
  type Registry,
  type Screen,
  type SpecNode,
  type SpecRun,
  tokenNames,
  variantName,
} from "./compile/compile.js";
export type { IRNode, IRStory, Sizing, TextRun, Tokened } from "./compile/ir.js";
export { parseBoxShadow, type ShadowEffect } from "./compile/shadow.js";
export { isWindowBar, markPresentation, presentationLayers } from "./design/presentation.js";
export { diff, type Item, type Kind, keysById, locate } from "./diff/diff.js";
export {
  type ClaimRecord,
  ClaimRecordSchema,
  type IndexEntry,
  IndexEntrySchema,
  LAYOUT,
  LEGACY_NS,
  type Meta,
  MetaSchema,
  NODE,
  NS,
  ROOT,
} from "./file/model.js";
export {
  adoptForeignVariables,
  type Change,
  changeKey,
  cssVar,
  group,
  layerOf,
  TOKENS_COLLECTION,
  tokenForVariable,
} from "./group/group.js";
export { type EventKind, EventSchema, type LedgerEvent, ordered, readEvent } from "./ledger/events.js";
export { type ComponentState, fold, initialState, type State, step } from "./ledger/state.js";
export { type Classified, type MergeReport, merge } from "./merge/merge.js";
export * as protocol from "./protocol.js";
export { CANON_VERSION, canonicalize, diffPaths, type Raw, stringify } from "./snapshot/canonical.js";
export {
  type CodeComponent,
  type CodeToken,
  codeProps,
  compareComponents,
  type DesignerVariable,
  type LibraryComponent,
  mapProps,
  mapVariant,
  normName,
  type PropMap,
  type Props,
  parseVariant,
  type Suggestion,
  type SystemUse,
  suggestLinks,
  suggestTokens,
  systemUses,
  type TokenSuggestion,
  usesLines,
  type VariantLook,
} from "./system/system.js";
export { hash } from "./util/hash.js";
export { keyOfTitle, pageNames, pascalOf } from "./util/key.js";

export const VERSION = "0.0.0";
export { crashSignature, gapSignature, signatureOf, type TelemetryEvent, type TelemetryKind, type TelemetrySource } from "./telemetry.js";
