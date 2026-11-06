'use client';

import { useEffect, useRef, type ReactNode, type RefObject } from 'react';

interface Props {
  open: boolean;
  onClose: () => void;
  /** While true, Esc does not close it: something is waiting on the wallet or on Hedera. */
  busy?: boolean;
  labelledBy: string;
  describedBy?: string;
  /** Takes focus on open. Otherwise the browser picks the first control. */
  initialFocus?: RefObject<HTMLElement | null>;
  className?: string;
  children: ReactNode;
}

/**
 * A native modal dialog, which traps Tab, closes on Esc, makes the page behind it inert and returns
 * focus to the opener. Children stay mounted while it is closed, so nothing in progress is lost.
 */
/** Replaces the actions once a transaction is confirmed, and takes focus because they are gone. */
export function DialogDone({ onClose }: { onClose: () => void }) {
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => close.current?.focus(), []);
  return (
    <button ref={close} type="button" className="btn btn-outline" onClick={onClose}>
      Close
    </button>
  );
}

export function Dialog({ open, onClose, busy = false, labelledBy, describedBy, initialFocus, className, children }: Props) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      initialFocus?.current?.focus();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open, initialFocus]);

  return (
    <dialog
      ref={ref}
      className={`dialog${className ? ` ${className}` : ''}`}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      onCancel={(e) => {
        if (busy) e.preventDefault();
      }}
      onClose={onClose}
    >
      {children}
    </dialog>
  );
}
