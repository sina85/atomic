# PR #1753 Acceptance — Other Findings

## Clipboard image hotkey inserts a path instead of an image attachment

- **Classification:** Other Atomic.
- **Observed behavior:** In an actual source-built Atomic TUI, `Ctrl+V` with a PNG on the macOS clipboard created a private temporary PNG but inserted only its filesystem path into the editor. Submitting the turn produced a text-only user message; the selected model treated the path as text and attempted to use tools rather than receiving image content.
- **Sanitized reproduction/evidence:** Select any model in the TUI, place the independently verified test PNG on the clipboard with `osascript`, press `Ctrl+V`, append a request to identify the image, and submit. Evidence: `/tmp/atomic-pr1753-live-xKscfO/img-composer-clipboard.txt`. The editor displayed `/tmp/atomic-clipboard-<uuid>.png`, and the resulting user entry had no image content block. Raw session files and the temporary clipboard image were removed during credential/session cleanup.
- **Affected locations:** `packages/coding-agent/src/modes/interactive/chat-input-actions.ts:130-149` (`pasteClipboardImageToEditor` writes a temp file and inserts only `filePath`); downstream interactive submission did not convert that path to an attachment.
- **Likely cause (high confidence):** The clipboard action and submission pipeline lack a durable attachment token/content-block handoff; raw path insertion is indistinguishable from ordinary text.
- **Impact:** The advertised “Paste image from clipboard” control does not pass image bytes to the provider and can cause tool attempts or hallucinated analysis.
- **Why outside PR #1753:** The defect is in provider-neutral Atomic editor/clipboard handling and is not introduced by Cursor catalog discovery, variant mapping, or routing changes.
- **Recommended follow-up:** Represent pasted images as structured pending attachments and emit image content blocks on submit; add an interactive regression test proving the provider receives image content and that temporary files are cleaned up.

## Cursor advertises GLM-5.2 but rejects its exact route for this account

- **Classification:** Cursor-related outside PR — advertised by Cursor but unavailable/unroutable for this account, region, or server.
- **Observed behavior:** Authenticated Cursor discovery includes `glm-5.2`, and the provider-qualified picker selection `cursor/glm-5.2` selects `(cursor) glm-5.2 high`. A real Cursor turn then returns deterministic `not_found`, error stop, and zero usage. The model is not missing from Atomic's picker and no Atomic fallback occurred.
- **Sanitized reproduction/evidence:** In the source-built TUI, open `/model`, search for the provider-qualified `cursor/glm-5.2`, select it, and send a unique canary. Current post-fix evidence: `/tmp/atomic-pr1753-live-round3-dCTqni/rows/048-glm-5.2.txt`, `/tmp/atomic-pr1753-live-round3-dCTqni/row-status.tsv`, and `/tmp/atomic-pr1753-live-round3-dCTqni/live-summary.json`; independent reviewer evidence: `/tmp/atomic-pr1753-live-xKscfO/reviewer-glm-cursor-pane.txt` and `/tmp/atomic-pr1753-live-xKscfO/reviewer-glm-cursor-session.json`. The reviewer session records `provider: cursor`, `model: glm-5.2`, `stopReason: error`, all usage fields zero, and `Cursor stream ended with not_found: Error.` The broader current matrix shows the same deterministic gating pattern for many advertised Claude, GPT-5.4/5.5/5.6, and Grok rows; exact affected rows and outcomes are retained in the round-three matrix artifacts.
- **Affected locations:** Cursor's authenticated AvailableModels response and live stream routing service; Atomic's mapped row is sourced from `packages/cursor/src/model-mapper.ts` but current evidence does not identify an Atomic mapping defect for this route.
- **Likely cause (medium confidence):** Cursor-side entitlement/account gating, stale authenticated advertisement, or region/server routing inconsistency. The private protocol does not distinguish these causes.
- **Impact:** Users can select an honestly advertised row that cannot stream for this account; Atomic correctly surfaces the provider rejection with no usage or fallback.
- **Why outside PR #1753:** PR #1753 must preserve and route exact advertised tuples. Suppressing the row or relabeling `not_found` as success would contradict that intent; the rejection is external to the verified Atomic route.
- **Recommended follow-up:** Recheck the same account across Cursor client/server versions and regions, compare entitlement metadata if Cursor exposes it, and ask Cursor to reconcile AvailableModels with stream-route availability.

## Bare GLM-5.2 picker query was ambiguous across providers during QA

- **Classification:** Transient QA automation ambiguity, not an Atomic product defect.
- **Observed behavior:** The original automation searched the bare ID `glm-5.2`; the picker selected Zai's colliding row, producing a successful Zai turn that was initially misclassified as Cursor coverage.
- **Sanitized reproduction/evidence:** `/tmp/atomic-pr1753-live-xKscfO/final-rows/048-glm-5.2.txt` ends on `(zai) glm-5.2 high`. The corrected provider-qualified evidence is recorded in the preceding finding.
- **Affected locations:** Acceptance automation search input only; the picker exposed provider labels and accepted a provider-qualified query.
- **Likely cause (high confidence):** The automation used an ambiguous bare model ID instead of `cursor/glm-5.2` and failed to assert the selected footer provider before sending.
- **Impact:** One QA result was attributed to the wrong provider; no runtime fallback or provider-routing defect occurred.
- **Why outside PR #1753:** This was a test-driver oracle error, not product behavior requiring repair.
- **Recommended follow-up:** Always use provider-qualified picker searches and assert the selected provider/model footer or session `model_change` before each matrix turn.
