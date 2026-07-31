"use client";

import * as React from "react";
import { Dialog as DialogPrimitive } from "radix-ui";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { XIcon } from "lucide-react";

function Dialog({ ...props }: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />;
}

function DialogTrigger({ ...props }: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

function DialogPortal({ ...props }: React.ComponentProps<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />;
}

function DialogClose({ ...props }: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

function DialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn(
        // DEVIATION FROM THE shadcn/radix-nova PRESET (task #171, deferred
        // from #127's review, verified — never rendered against a real
        // consumer, since nothing under src/app imports this file yet).
        // The generated black overlay sat at a tenth of full opacity, tuned
        // for a light page: composited over this app's near-black ground
        // (--bg-sunken #070709) that barely moves the result, so the rest
        // of the page never reads as inert.
        //
        // CHOSEN VALUE: two-fifths opacity, picked by the COMPOSITED
        // result, not the number. Alpha-blended (channel * (1 - alpha))
        // against real foreground colours, not the ground itself, because
        // the overlay's job is to dim what sits ON the near-black ground
        // (text, photos, the brand accent), which the ground colour itself
        // cannot show:
        //   - a tenth (the original):  --fg #eceaf2 -> rgb(212,211,218),
        //     --accent #c8a15a -> rgb(180,145,81) — both within ~10% of
        //     their source, i.e. the "attenuates nothing measurable" defect
        //     this ticket exists for.
        //   - three-tenths (considered, rejected): --fg -> rgb(165,164,169),
        //     --accent -> rgb(140,113,63) — a real but mild step, still
        //     close enough to "full brightness" that a quick glance reads
        //     the background as merely dim, not inert.
        //   - two-fifths (shipped): --fg -> rgb(142,140,145), a clear drop
        //     from "bright" to "muted mid-grey"; --accent ->
        //     rgb(120,97,54), still recognisably brass but visibly pulled
        //     back. This is the value where the composited result reads as
        //     "the rest of the page stepped back", which is the acceptance
        //     criterion.
        //   - three-fifths and denser (rejected): flattens the depth this
        //     cinema-black system is built on, which is the trap the
        //     ticket warns against explicitly — the goal is attenuation,
        //     not an opaque curtain.
        //
        // Backdrop blur doubled to match the one blurred surface the mock
        // actually has — the sticky action bar, design/system/dashboard
        // .html:403-408 (also an 8px blur) — since no dialog exists in the
        // mock to match directly. Still gated behind
        // `supports-backdrop-filter` so browsers without it fall back to
        // the background opacity alone.
        "data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0 fixed inset-0 isolate z-50 bg-black/40 duration-100 supports-backdrop-filter:backdrop-blur-sm",
        className,
      )}
      {...props}
    />
  );
}

function DialogContent({
  className,
  children,
  showCloseButton = true,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  showCloseButton?: boolean;
}) {
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        className={cn(
          "bg-popover text-popover-foreground ring-foreground/10 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 fixed top-1/2 left-1/2 z-50 grid w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 gap-4 rounded-xl p-4 text-sm ring-1 duration-100 outline-none sm:max-w-sm",
          className,
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close data-slot="dialog-close" asChild>
            <Button variant="ghost" className="absolute top-2 right-2" size="icon-sm">
              <XIcon />
              <span className="sr-only">Close</span>
            </Button>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPortal>
  );
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div data-slot="dialog-header" className={cn("flex flex-col gap-2", className)} {...props} />
  );
}

function DialogFooter({
  className,
  showCloseButton = false,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  showCloseButton?: boolean;
}) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        "bg-muted/50 -mx-4 -mb-4 flex flex-col-reverse gap-2 rounded-b-xl border-t p-4 sm:flex-row sm:justify-end",
        className,
      )}
      {...props}
    >
      {children}
      {showCloseButton && (
        <DialogPrimitive.Close asChild>
          <Button variant="outline">Close</Button>
        </DialogPrimitive.Close>
      )}
    </div>
  );
}

function DialogTitle({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn("text-base leading-none font-medium", className)}
      {...props}
    />
  );
}

function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn(
        "text-muted-foreground *:[a]:hover:text-foreground text-sm *:[a]:underline *:[a]:underline-offset-3",
        className,
      )}
      {...props}
    />
  );
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
};
