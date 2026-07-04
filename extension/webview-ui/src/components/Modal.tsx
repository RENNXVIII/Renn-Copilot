import type { ReactNode } from "react";

export function Modal({ open, onClose, children }: { open: boolean; onClose: () => void; children: ReactNode }) {
  if (!open) return null;
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box" onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}

export function ModalHeader({ title, description, onClose }: { title: string; description?: string; onClose: () => void }) {
  return (
    <div className="modal-header">
      <div>
        <div className="card-title">{title}</div>
        {description && <div className="card-desc">{description}</div>}
      </div>
      <button className="modal-close" onClick={onClose}>
        ✕
      </button>
    </div>
  );
}

export function MaskedEmail({ email, revealed }: { email: string; revealed: boolean }) {
  return <>{revealed ? email : maskEmailInline(email)}</>;
}

function maskEmailInline(value: string): string {
  const at = value.indexOf("@");
  if (at <= 0) return value;
  const local = value.slice(0, at);
  const domain = value.slice(at);
  const visible = local.slice(0, Math.min(2, local.length));
  return `${visible}${"•".repeat(Math.max(3, local.length - visible.length))}${domain}`;
}
