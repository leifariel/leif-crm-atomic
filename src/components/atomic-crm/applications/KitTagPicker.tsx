import { useEffect, useMemo, useState } from "react";
import { useDataProvider } from "ra-core";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import { createKitTag, kitTags, type KitTag } from "./kitTagActions";

// Choosing a Kit tag, by name, from the real catalog.
//
// Leif should never copy a numeric tag id out of Kit again — so this loads his
// account's actual tags, searches them, and can create one without leaving the
// CRM. Selection is always BY ID: Kit's create is idempotent on name, but
// names are what a human reads and ids are what a tag operation must carry.
//
// The browser never reaches Kit. The catalog arrives through the kit_sync
// Edge Function, which is the only thing holding the credential.
export const KitTagPicker = ({
  value,
  onChange,
  disabled,
}: {
  value: KitTag | null;
  onChange: (tag: KitTag | null) => void;
  disabled?: boolean;
}) => {
  const dataProvider = useDataProvider();
  const [catalog, setCatalog] = useState<KitTag[] | null>(null);
  const [error, setError] = useState(false);
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    let cancelled = false;
    kitTags(dataProvider)
      .then((tags) => {
        if (!cancelled) setCatalog(tags);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [dataProvider]);

  const search = query.trim();
  const matches = useMemo(() => {
    const all = catalog ?? [];
    if (!search) return all.slice(0, 8);
    return all
      .filter((tag) => tag.name.toLowerCase().includes(search.toLowerCase()))
      .slice(0, 8);
  }, [catalog, search]);

  // Offered only when nothing in the catalog already carries that exact name.
  // Kit would return the existing tag anyway, so the button would be a lie
  // about what is about to happen.
  const exact = (catalog ?? []).some(
    (tag) => tag.name.toLowerCase() === search.toLowerCase(),
  );
  const canCreate = search.length > 0 && !exact && !error;

  const onCreate = async () => {
    setCreating(true);
    try {
      const tag = await createKitTag(dataProvider, search);
      // Kit's create is idempotent on name: an existing one comes back rather
      // than a duplicate, so this is a selection either way.
      setCatalog((current) => {
        const rest = (current ?? []).filter((one) => one.id !== tag.id);
        return [...rest, tag].sort((a, b) => a.name.localeCompare(b.name));
      });
      onChange(tag);
      setQuery("");
    } catch {
      setError(true);
    } finally {
      setCreating(false);
    }
  };

  if (value) {
    return (
      <div className="flex items-center gap-2">
        <span className="text-sm">{value.name}</span>
        {!disabled && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onChange(null)}
          >
            Change
          </Button>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <Input
        value={query}
        disabled={disabled}
        placeholder="Search your Kit tags"
        onChange={(event) => setQuery(event.target.value)}
      />
      {error && (
        <span className="text-sm text-muted-foreground">
          Could not reach Kit just now, so the tag list is unavailable.
        </span>
      )}
      {!error && catalog === null && (
        <span className="text-sm text-muted-foreground">
          Loading your Kit tags…
        </span>
      )}
      {!error && catalog !== null && (
        <ul className="flex flex-col gap-1">
          {matches.map((tag) => (
            <li key={tag.id}>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="justify-start w-full"
                disabled={disabled}
                onClick={() => onChange(tag)}
              >
                {tag.name}
              </Button>
            </li>
          ))}
          {matches.length === 0 && !canCreate && (
            <li className="text-sm text-muted-foreground">No matching tags.</li>
          )}
        </ul>
      )}
      {canCreate && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="self-start"
          disabled={disabled || creating}
          onClick={onCreate}
        >
          Create “{search}”
        </Button>
      )}
    </div>
  );
};
