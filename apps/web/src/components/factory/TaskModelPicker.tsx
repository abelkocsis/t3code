import type { EnvironmentId, ModelSelection } from "@t3tools/contracts";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import { createModelSelection } from "@t3tools/shared/model";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  resolveDefaultProviderModelSelection,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { useEnvironments } from "../../state/environments";
import { EMPTY_SERVER_PROVIDERS } from "../../state/server";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { TraitsPicker } from "../chat/TraitsPicker";

/**
 * The model and effort a new factory task starts with. It opens on the project's default
 * model, so a task the user does not touch starts the way it always did.
 */
export function TaskModelPicker({
  environmentId,
  project,
  value,
  onChange,
}: {
  environmentId: EnvironmentId;
  project: EnvironmentProject | null;
  /** The user's pick; null follows the project default. */
  value: ModelSelection | null;
  onChange: (selection: ModelSelection) => void;
}) {
  const settings = useEnvironmentSettings(environmentId);
  const { environments } = useEnvironments();
  const providers =
    environments.find((environment) => environment.environmentId === environmentId)?.serverConfig
      ?.providers ?? EMPTY_SERVER_PROVIDERS;
  const projectDefault = project
    ? (resolveProjectSettings(settings, project.id, project).settings.defaultModelSelection ??
      project.defaultModelSelection)
    : settings.defaultModelSelection;
  const selection = resolveDefaultProviderModelSelection(providers, value ?? projectDefault);
  const entries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings),
  );
  const activeEntry = entries.find((entry) => entry.instanceId === selection?.instanceId);
  if (!selection || !activeEntry) return null;
  const modelOptions = getCustomModelOptionsByInstance(
    settings,
    providers,
    selection.instanceId,
    selection.model,
  );

  return (
    <div className="flex items-center gap-1">
      <ProviderModelPicker
        activeInstanceId={selection.instanceId}
        model={selection.model}
        lockedProvider={null}
        instanceEntries={entries}
        modelOptionsByInstance={modelOptions}
        onInstanceModelChange={(instanceId, model) =>
          onChange(createModelSelection(instanceId, model))
        }
      />
      <TraitsPicker
        provider={activeEntry.driverKind}
        models={activeEntry.models}
        model={selection.model}
        prompt=""
        onPromptChange={() => {}}
        modelOptions={selection.options ?? []}
        allowPromptInjectedEffort={false}
        planModeEnabled={settings.planModeEnabled}
        onModelOptionsChange={(options) =>
          onChange(createModelSelection(selection.instanceId, selection.model, options))
        }
      />
    </div>
  );
}
