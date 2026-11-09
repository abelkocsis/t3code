import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import * as Electron from "electron";

export class ElectronPowerSaveBlockerError extends Schema.TaggedError<ElectronPowerSaveBlockerError>()(
  "ElectronPowerSaveBlockerError",
  {
    operation: Schema.Literals(["start", "stop"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `The power save blocker failed to ${this.operation}.`;
  }
}

export class ElectronPowerSaveBlocker extends Context.Service<
  ElectronPowerSaveBlocker,
  {
    readonly hold: (active: boolean) => Effect.Effect<void>;
    readonly isHolding: Effect.Effect<boolean>;
  }
>()("@t3tools/desktop/electron/ElectronPowerSaveBlocker") {}

const make = Effect.gen(function* () {
  const blockerIdRef = yield* Ref.make<number | null>(null);

  const logAndContinue = (error: ElectronPowerSaveBlockerError) =>
    Effect.logWarning(error.message, { cause: error.cause });

  const start = Effect.gen(function* () {
    const current = yield* Ref.get(blockerIdRef);
    if (current !== null && Electron.powerSaveBlocker.isStarted(current)) return;
    const id = yield* Effect.try({
      try: () => Electron.powerSaveBlocker.start("prevent-display-sleep"),
      catch: (cause) => new ElectronPowerSaveBlockerError({ operation: "start", cause }),
    });
    yield* Ref.set(blockerIdRef, id);
  });

  const stop = Effect.gen(function* () {
    const current = yield* Ref.getAndSet(blockerIdRef, null);
    if (current === null) return;
    yield* Effect.try({
      try: () => {
        if (Electron.powerSaveBlocker.isStarted(current)) {
          Electron.powerSaveBlocker.stop(current);
        }
      },
      catch: (cause) => new ElectronPowerSaveBlockerError({ operation: "stop", cause }),
    });
  });

  return ElectronPowerSaveBlocker.of({
    hold: Effect.fn("ElectronPowerSaveBlocker.hold")((active) =>
      (active ? start : stop).pipe(
        Effect.catchTags({ ElectronPowerSaveBlockerError: logAndContinue }),
      ),
    ),
    isHolding: Ref.get(blockerIdRef).pipe(
      Effect.map((id) => id !== null && Electron.powerSaveBlocker.isStarted(id)),
    ),
  });
});

export const layer = Layer.effect(ElectronPowerSaveBlocker, make);
