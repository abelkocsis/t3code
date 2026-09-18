import { ExternalLinkIcon } from "lucide-react";

import { useUpstreamRelease } from "../../hooks/useUpstreamRelease";
import { Button } from "../ui/button";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

/**
 * Tells the fork's maintainer when upstream has tagged a stable release newer
 * than the one this branch sits on, which is the signal to run
 * `scripts/fork-update.sh`. The row stays silent until the first check answers,
 * and says nothing about nightly or preview tags: this fork only replays onto
 * stable releases.
 */
export function UpstreamReleaseSection() {
  const status = useUpstreamRelease();
  if (status === null) return null;

  const published =
    status.latest.publishedAt === null
      ? null
      : new Date(status.latest.publishedAt).toLocaleDateString();

  return (
    <SettingsRow
      {...searchableSetting("upstream-release")}
      description={
        status.isBehind
          ? `Upstream released ${status.latest.tag}${published ? ` on ${published}` : ""}. This build is on ${status.baseTag}. Run scripts/fork-update.sh to replay onto it.`
          : `This build is on ${status.baseTag}, the newest upstream stable release.`
      }
      status={status.isBehind ? <span className="text-warning">Update available</span> : null}
      control={
        <Button
          size="sm"
          variant="outline"
          render={<a href={status.latest.url} rel="noreferrer noopener" target="_blank" />}
        >
          <ExternalLinkIcon aria-hidden />
          Release notes
        </Button>
      }
    />
  );
}
