"use client";

import { useRef } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * A styled replacement for `window.prompt`.
 *
 * The native prompt froze the whole tab, could not be styled, and looked like a
 * browser alert inside an otherwise custom editor. This keeps the same contract
 * -- one line of text, an OK and a Cancel -- but as a real dialog.
 *
 * The field is uncontrolled and read through a ref on submit. Radix unmounts the
 * dialog content while it is closed, so `defaultValue` is re-applied on every
 * open without an effect that would set state during render.
 */
export default function PromptDialog({
  open,
  onOpenChange,
  title,
  description,
  placeholder,
  defaultValue = "",
  submitLabel = "Insert",
  onConfirm,
}) {
  const inputRef = useRef(null);

  function submit(event) {
    event.preventDefault();
    onConfirm(inputRef.current?.value.trim() ?? "");
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            {description ? <DialogDescription>{description}</DialogDescription> : null}
          </DialogHeader>
          <Input
            ref={inputRef}
            defaultValue={defaultValue}
            placeholder={placeholder}
            autoComplete="off"
            spellCheck={false}
          />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit">{submitLabel}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
