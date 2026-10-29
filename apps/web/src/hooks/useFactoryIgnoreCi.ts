import { useEnvironments } from "../state/environments";
import { serverEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";

export function useFactoryIgnoreCi() {
  const { environments } = useEnvironments();
  const persistSettings = useAtomCommand(
    serverEnvironment.updateSettings,
    "factory ignore CI update",
  );
  const targets = environments.filter(
    (environment) =>
      environment.connection.phase === "connected" &&
      environment.serverConfig?.settings.factoryIgnoreCiEnabled === true,
  );
  return {
    supported: targets.length > 0,
    enabled:
      targets.length > 0 &&
      targets.every((target) => target.serverConfig?.settings.factoryIgnoreCi === true),
    setEnabled: async (enabled: boolean) => {
      await Promise.all(
        targets.map((target) =>
          persistSettings({
            environmentId: target.environmentId,
            input: { patch: { factoryIgnoreCi: enabled } },
          }),
        ),
      );
    },
  };
}
