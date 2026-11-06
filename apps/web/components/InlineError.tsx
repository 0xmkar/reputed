interface Props {
  message: string;
  onRetry?: () => void;
}

export function InlineError({ message, onRetry }: Props) {
  return (
    <div className="inline-error" role="alert">
      <span>{message}</span>
      {onRetry && (
        <button type="button" className="btn btn-outline btn-small" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}
