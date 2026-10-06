import { CircleX, Edit, Save, Trash2 } from "lucide-react";
import {
  Form,
  useDelete,
  useGetIdentity,
  useNotify,
  useResourceContext,
  useTranslate,
  useUpdate,
} from "ra-core";
import { useEffect, useRef, useState } from "react";
import type { FieldValues, SubmitHandler } from "react-hook-form";
import { ReferenceField } from "@/components/admin/reference-field";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

import { CompanyAvatar } from "../companies/CompanyAvatar";
import { Markdown } from "../misc/Markdown";
import { RelativeDate } from "../misc/RelativeDate";
import { Status } from "../misc/Status";
import type { ApplicationNote, ContactNote, DealNote } from "../types";
import { NoteAttachments } from "./NoteAttachments";
import { NoteInputs } from "./NoteInputs";
import { useGetSalesName } from "../sales/useGetSalesName";
import { formatTimestampWithTimeString } from "../deals/dealUtils";

export const Note = ({
  showStatus,
  note,
  variant = "default",
}: {
  showStatus?: boolean;
  note: DealNote | ContactNote | ApplicationNote;
  isLast: boolean;
  // "compact" is for a note that already sits inside its own bordered
  // container and belongs to a record with no company — an Application.
  // It drops the company avatar and replaces "You added a note" plus the
  // right-aligned relative date with one secondary byline, so the note's
  // own words are the primary thing on the row. Every other caller keeps
  // "default", unchanged.
  variant?: "default" | "compact";
}) => {
  const [isHover, setHover] = useState(false);
  const [isEditing, setEditing] = useState(false);
  const [isExpanded, setExpanded] = useState(false);
  const [isTruncated, setTruncated] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const resource = useResourceContext();
  const notify = useNotify();
  const translate = useTranslate();
  const { identity } = useGetIdentity();
  const isCurrentUser = note.sales_id === identity?.id;
  const compact = variant === "compact";
  // The compact byline names the author even when it is the current user,
  // so the name has to be fetched in that case too.
  const salesName = useGetSalesName(note.sales_id, {
    enabled: compact || !isCurrentUser,
  });

  // Detect if content is truncated
  useEffect(() => {
    const el = contentRef.current;
    if (el) {
      setTruncated(el.scrollHeight > el.clientHeight);
    }
  }, [note.text]);

  const [update, { isPending }] = useUpdate();

  const [deleteNote] = useDelete(resource, undefined, {
    mutationMode: "undoable",
    onSuccess: () => {
      notify("resources.notes.deleted", {
        type: "info",
        undoable: true,
        messageArgs: {
          _: "Note deleted",
        },
      });
    },
  });

  const handleDelete = () => {
    deleteNote(resource, { id: note.id, previousData: note });
  };

  const handleEnterEditMode = () => {
    setEditing(!isEditing);
  };

  const handleCancelEdit = () => {
    setEditing(false);
    setHover(false);
  };

  const handleNoteUpdate: SubmitHandler<FieldValues> = (values) => {
    update(
      resource,
      { id: note.id, data: values, previousData: note },
      {
        onSuccess: () => {
          setEditing(false);
          setHover(false);
        },
      },
    );
  };

  const content = (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className={compact ? undefined : "mb-4"}
    >
      <div className="flex items-center space-x-4 w-full">
        {!compact && (
          <ReferenceField source="company_id" reference="companies" link="show">
            <CompanyAvatar width={20} height={20} />
          </ReferenceField>
        )}
        <div className="inline-flex h-full items-center text-sm text-muted-foreground">
          {compact
            ? [salesName, formatTimestampWithTimeString(note.date)]
                .filter(Boolean)
                .join(" · ")
            : translate(
                isCurrentUser
                  ? "resources.notes.you_added"
                  : "resources.notes.author_added",
                { name: salesName },
              )}{" "}
          {showStatus && note.status && (
            <Status className="ml-2" status={note.status} />
          )}
        </div>
        <span className={`${isHover ? "visible" : "invisible"}`}>
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleEnterEditMode}
                  className="p-1 h-auto cursor-pointer"
                >
                  <Edit className="w-4 h-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                <p>{translate("resources.notes.action.edit")}</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleDelete}
                  className="p-1 h-auto cursor-pointer"
                >
                  <Trash2 className="w-4 h-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                <p>{translate("resources.notes.action.delete")}</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </span>
        <div className="flex-1"></div>
        {!compact && (
          <span className="text-sm text-muted-foreground">
            <RelativeDate date={note.date} />
          </span>
        )}
      </div>
      {isEditing ? (
        <Form onSubmit={handleNoteUpdate} record={note} className="mt-1">
          <NoteInputs showStatus={showStatus} />
          <div className="flex justify-end mt-2 space-x-4">
            <Button
              variant="ghost"
              onClick={handleCancelEdit}
              type="button"
              className="cursor-pointer"
            >
              <CircleX className="w-4 h-4" />
              {translate("ra.action.cancel")}
            </Button>
            <Button
              type="submit"
              disabled={isPending}
              className="flex items-center gap-2 cursor-pointer"
            >
              <Save className="w-4 h-4" />
              {translate("resources.notes.action.update")}
            </Button>
          </div>
        </Form>
      ) : (
        <div className="pt-2 text-sm max-w-150">
          {note.text && (
            <div
              ref={contentRef}
              className={cn(
                "overflow-hidden transition-[max-height] duration-300 ease-in-out",
                isExpanded ? "max-h-[5000px]" : "max-h-46",
              )}
            >
              <Markdown>{note.text}</Markdown>
            </div>
          )}
          {isTruncated && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                setExpanded(!isExpanded);
              }}
              className="text-primary text-sm mt-1 underline hover:no-underline cursor-pointer"
            >
              {isExpanded
                ? translate("crm.common.show_less")
                : translate("crm.common.read_more")}
            </button>
          )}

          {note.attachments && <NoteAttachments note={note} />}
        </div>
      )}
    </div>
  );

  return content;
};
