/**
 * The Factory page's token saving switch. It is a server setting, so the review sweep reads
 * it with no client connected; the switch writes every connected factory server at once.
 */
import { useCallback, useMemo } from "react";

import { useEnvironments } from "../state/environments";
import { serverEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";

export interface FactoryTokenSavingApi {
  /** On only when every connected factory server has it on. */
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

  const targets = useMemo(
    () =>
      environments.flatMap((environment) =>
        environment.connection.phase === "connected" &&
        environment.serverConfig?.environment.capabilities.threadFactory === true
          ? [
              {
                environmentId: environment.environmentId,
                enabled: environment.serverConfig.settings.factoryTokenSaving === true,
              },
            ]
          : [],
      ),
    [environments],
  );

  const setEnabled = useCallback(
    async (enabled: boolean) => {
      await Promise.all(
        targets.map((target) =>
          persistServerSettings({
            environmentId: target.environmentId,
            input: { patch: { factoryTokenSaving: enabled } },
          }),
        ),
      );
    },
    [persistServerSettings, targets],
  );

  return {
    enabled: targets.length > 0 && targets.every((target) => target.enabled),
    supported: targets.length > 0,
    setEnabled,
  };
}
