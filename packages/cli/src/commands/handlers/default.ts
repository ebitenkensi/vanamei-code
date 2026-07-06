import { Commands } from "../commands"
import { Runtime } from "../../framework/runtime"
import { Effect } from "effect"
import { Daemon } from "../../services/daemon"

export default Runtime.handler(Commands, () =>
  Effect.gen(function* () {
    const daemon = yield* Daemon.Service
    const url = yield* daemon.start()
    const password = yield* daemon.password()
    const { runMini } = yield* Effect.promise(() => import("opencode/cli/cmd/run"))
    yield* Effect.promise(() => runMini({ attach: url, password }))
  }),
)
