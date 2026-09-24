import { SaveButton } from "@/components/admin/form";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  EditBase,
  Form,
  useNotify,
  useRedirect,
  useResourceContext,
  useTranslate,
  type EditBaseProps,
  type FormProps,
} from "ra-core";
import { type ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface EditDialogProps extends EditBaseProps {
  children: ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: ReactNode;
  defaultValues?: FormProps["defaultValues"];
  headerActions?: ReactNode;
}

/**
 * A centered modal containing an edit form — the same API as EditSheet, so
 * a caller switches between them by changing one component name.
 *
 * The counterpart CreateDialog already is for CreateSheet, and it exists
 * for the same reason that one does. EditSheet renders a bottom sheet at
 * `h-dvh`, the full height of the viewport: right for a long
 * multi-section form, absurd for editing one row, where it produced a
 * screenful of empty space under three short fields. This sizes to its
 * content instead, capped, with the body scrolling only if it genuinely
 * overflows.
 *
 * Success handling is identical to EditSheet's, so the two stay
 * behaviorally interchangeable and neither becomes a second, subtly
 * different path.
 */
export const EditDialog = ({
  children,
  open,
  onOpenChange,
  title = "Edit",
  redirect: redirectTo = "show",
  mutationOptions,
  mutationMode = "undoable",
  defaultValues,
  headerActions,
  ...editBaseProps
}: EditDialogProps) => {
  const resource = useResourceContext(editBaseProps);
  const translate = useTranslate();
  const notify = useNotify();
  const redirect = useRedirect();

  const handleSuccess = (...args: any[]) => {
    if (mutationOptions?.onSuccess) {
      return mutationOptions.onSuccess(
        ...(args as Parameters<typeof mutationOptions.onSuccess>),
      );
    }
    const [data] = args;
    notify(`resources.${resource}.notifications.updated`, {
      type: "info",
      messageArgs: {
        smart_count: 1,
        _: translate(`ra.notification.updated`, { smart_count: 1 }),
      },
      undoable: mutationMode === "undoable",
    });
    redirect(redirectTo, resource, data.id, data);
    onOpenChange(false);
  };

  const enhancedMutationOptions = {
    ...mutationOptions,
    onSuccess: handleSuccess,
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-md gap-0 p-0"
        aria-describedby={undefined}
      >
        <EditBase
          {...editBaseProps}
          redirect={redirectTo}
          mutationMode={mutationMode}
          mutationOptions={enhancedMutationOptions}
        >
          <Form defaultValues={defaultValues} className="flex flex-col">
            <DialogHeader className="border-b px-5 py-4">
              <div
                className={cn(
                  "flex items-center gap-2",
                  headerActions && "pr-8",
                )}
              >
                <DialogTitle className="min-w-0 flex-1 truncate text-base font-semibold">
                  {title}
                </DialogTitle>
                {headerActions && (
                  <div className="shrink-0">{headerActions}</div>
                )}
              </div>
            </DialogHeader>

            <div className="flex max-h-[60vh] flex-col gap-4 overflow-y-auto px-5 py-4">
              {children}
            </div>

            <DialogFooter className="border-t px-5 py-3">
              <SaveButton className="w-full" />
            </DialogFooter>
          </Form>
        </EditBase>
      </DialogContent>
    </Dialog>
  );
};
