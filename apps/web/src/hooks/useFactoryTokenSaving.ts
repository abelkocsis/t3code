/**
 * The Factory page's token saving switch. It is a server setting, so the review sweep reads
 * it with no client connected; the switch writes every connected server at once.
 */
import { useEnvironments } from "../state/environments";
import { serverEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";

export interface FactoryTokenSavingApi {
  /** On only when every connected server has it on. */
  readonly enabled: boolean;
  readonly supported: boolean;
  readonly setEnabled: (enabled: boolean) => Promise<void>;
}

export function useFactoryTokenSaving(): FactoryTokenSavingApi {
  const { environments } = useEnvironments();
  const persistServerSettings = useAtomCommand(
    serverEnvironment.updateSettings,
    "factory token saving update",
  );

  const targets = environments.flatMap((environment) =>
    environment.connection.phase === "connected" && environment.serverConfig
      ? [
          {
            environmentId: environment.environmentId,
            enabled: environment.serverConfig.settings.factoryTokenSaving === true,
          },
        ]
      : [],
  );

  return {
    enabled: targets.length > 0 && targets.every((target) => target.enabled),
    supported: targets.length > 0,
    setEnabled: async (enabled) => {
      await Promise.all(
        targets.map((target) =>
          persistServerSettings({
            environmentId: target.environmentId,
            input: { patch: { factoryTokenSaving: enabled } },
          }),
        ),
      );
    },
  };
}
