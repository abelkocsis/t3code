import { useEffect, useState } from "react";

import { onOpenIssuePicker } from "../../issuePickerBus";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { IssuePickerDialog } from "./IssuePickerDialog";

/**
 * Mounts the issue picker once and opens it on request.
 *
 * The picker searches one environment's account. It follows the primary
 * environment rather than the selected project's, because a user with no
 * project yet still has an account to search.
 */
export function IssuePickerHost() {
  const environmentId = usePrimaryEnvironmentId();
  const [open, setOpen] = useState(false);

  useEffect(() => onOpenIssuePicker(() => setOpen(true)), []);

  if (environmentId === null) return null;
  return <IssuePickerDialog open={open} onOpenChange={setOpen} environmentId={environmentId} />;
}
