# Third-party code

CoDesignFlo's own code is under the licences in LICENSE.md (MIT for the plugin, CLI and engine; FSL-1.1-ALv2 for the service and self-hosting). It includes the following third-party code, used under their licences:

| Code | Where | Licence |
|---|---|---|
| figwright serializer and schemas (packages/plugin/src/serializer.ts, packages/shared/src/design-context.ts, serialized-node.ts, design-context-dedupe.ts; plugin/src/gradient-angle.ts) | `packages/plugin/src/vendor/figwright/` (serializer, ported to zod/mini) | MIT — Copyright (c) 2026-present Roya. Full text: `packages/plugin/src/vendor/figwright/LICENSE` |
| Inter (Copyright 2016 The Inter Project Authors) and Space Grotesk (Copyright 2020 The Space Grotesk Project Authors) fonts | `service/web/public/fonts/` (served by codesignflo.com) | SIL Open Font License 1.1, https://openfontlicense.org; full text: `service/web/public/fonts/OFL.txt` |

The MIT notice above must be included in every distributed build that bundles this code (e.g. the Figma plugin zip).
