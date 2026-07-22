export * as ConfigDetach from "./detach"

import { Schema } from "effect"

export class Info extends Schema.Class<Info>("ConfigV2.Detach")({
  enabled: Schema.Boolean.pipe(Schema.optional),
}) {}
