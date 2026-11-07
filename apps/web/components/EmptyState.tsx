import Link from 'next/link';

interface Props {
  message: string;
  action?: { label: string; href: string } | { label: string; onClick: () => void };
}

export function EmptyState({ message, action }: Props) {
  return (
    <div className="empty-state">
      <p>{message}</p>
      {action &&
        ('href' in action ? (
          <Link href={action.href} className="btn btn-outline">
            {action.label}
          </Link>
        ) : (
          <button type="button" className="btn btn-outline" onClick={action.onClick}>
            {action.label}
          </button>
        ))}
    </div>
  );
}
