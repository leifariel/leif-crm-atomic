import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

import { kitFailureSentence, type KitStatus } from "./kitStatus";

// The one Kit state that gets a card, because it is the one Leif has to do
// something about. Everything healthy is a single muted line (KitStatusLine);
// this is the CRM's established "this needs you" language, the same rounded
// bordered card the client start-week and onboarding-repair cards use.
//
// Presentational on purpose: it is handed a status and a handler, and reads
// nothing for itself, so the status rules live in exactly one place.
export const KitSyncCard = ({
  status,
  retrying,
  onRetry,
}: {
  status: KitStatus;
  retrying: boolean;
  onRetry: () => void;
}) => (
  <Card>
    <CardContent className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex flex-col gap-1">
        <span className="text-sm font-medium">{status.label}</span>
        <span className="text-sm text-muted-foreground">
          This applicant was saved in the CRM, but Kit did not finish syncing,
          so the emails that follow from this have not gone out.
        </span>
        <span className="text-sm text-muted-foreground">
          {status.isRetryable
            ? kitFailureSentence(status.failureClass)
            : "This has been waiting longer than it should."}
        </span>
        {/* Everything technical stays shut until asked for: which tags did
            land, and Kit's own words about the one that did not. */}
        {(status.detail || status.tags.length > 0) && (
          <details className="text-xs text-muted-foreground">
            <summary className="cursor-pointer">Details</summary>
            {status.tags.length > 0 && (
              <span className="block">Applied: {status.tags.join(", ")}.</span>
            )}
            {status.detail && <span className="block">{status.detail}</span>}
          </details>
        )}
      </div>
      {status.isRetryable && (
        <Button
          type="button"
          size="sm"
          className="self-start sm:self-auto"
          disabled={retrying}
          onClick={onRetry}
        >
          Retry Kit sync
        </Button>
      )}
    </CardContent>
  </Card>
);
