import { SaveButton } from "@/components/admin/form";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  CreateBase,
  Form,
  ResourceContextProvider,
  useNotify,
  useRedirect,
  useResourceContext,
  useTranslate,
  type CreateBaseProps,
  type FormProps,
} from "ra-core";
import { type ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface CreateDialogProps extends CreateBaseProps {
  children: ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: ReactNode;
  defaultValues?: FormProps["defaultValues"];
  headerActions?: ReactNode;
  /**
   * Save through a domain action instead of a plain resource create.
   *
   * Some records cannot be created on their own. A manually entered
   * Application also establishes the Opportunity the review workflow
   * needs, in one transaction — so the save is one named domain
   * operation, not dataProvider.create("applications"). When this is
   * given, the caller owns notifying and closing, because only it knows
   * what its action actually did.
   */
  onSubmit?: (values: Record<string, unknown>) => void | Promise<void>;
}

/**
 * A centered modal containing a create form — the same API as CreateSheet,
 * so a caller switches between them by changing one component name.
 *
 * CreateSheet renders a full-height bottom sheet, which is right for long
 * multi-section forms but overwhelming for a short focused one: a
 * three-field action should not take over the whole viewport. This is the
 * small/focused/fast variant for those. It deliberately sizes to its
 * content (capped, with the body scrolling only if it genuinely overflows)
 * rather than stretching to the viewport, so the modal is never taller
 * than the form needs.
 */
export const CreateDialog = ({
  children,
  open,
  onOpenChange,
  title = "Create",
  redirect: redirectTo = "show",
  mutationOptions,
  defaultValues,
  headerActions,
  onSubmit,
  ...createBaseProps
}: CreateDialogProps) => {
  const resource = useResourceContext(createBaseProps);
  const translate = useTranslate();
  const notify = useNotify();
  const redirect = useRedirect();

  // Identical success handling to CreateSheet's, so the two are behaviorally
  // interchangeable and neither becomes a second, subtly-different path.
  const handleSuccess = (...args: any[]) => {
    if (mutationOptions?.onSuccess) {
      return mutationOptions.onSuccess(
        ...(args as Parameters<typeof mutationOptions.onSuccess>),
      );
    }
    const [data] = args;
    notify(`resources.${resource}.notifications.created`, {
      type: "info",
      messageArgs: {
        smart_count: 1,
        _: translate(`ra.notification.created`, { smart_count: 1 }),
      },
      undoable: createBaseProps.mutationMode === "undoable",
    });
    redirect(redirectTo, resource, data.id, data);
    onOpenChange(false);
  };

  const enhancedMutationOptions = {
    ...mutationOptions,
    onSuccess: handleSuccess,
  };

  const body = (
    <Form
      defaultValues={defaultValues}
      className="flex flex-col"
      onSubmit={onSubmit}
    >
      <DialogHeader className="border-b px-5 py-4">
        <div className={cn("flex items-center gap-2", headerActions && "pr-8")}>
          <DialogTitle className="min-w-0 flex-1 truncate text-base font-semibold">
            {title}
          </DialogTitle>
          {headerActions && <div className="shrink-0">{headerActions}</div>}
        </div>
      </DialogHeader>

      <div className="flex max-h-[60vh] flex-col gap-4 overflow-y-auto px-5 py-4">
        {children}
      </div>

      <DialogFooter className="border-t px-5 py-3">
        <SaveButton className="w-full" />
      </DialogFooter>
    </Form>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-md gap-0 p-0"
        aria-describedby={undefined}
      >
        {onSubmit ? (
          // No CreateBase: the domain action owns the write, so there is
          // no resource mutation for it to run, and nothing for it to
          // redirect or notify about.
          <ResourceContextProvider value={resource ?? ""}>
            {body}
          </ResourceContextProvider>
        ) : (
          <CreateBase
            {...createBaseProps}
            redirect={redirectTo}
            mutationOptions={enhancedMutationOptions}
          >
            {body}
          </CreateBase>
        )}
      </DialogContent>
    </Dialog>
  );
};
