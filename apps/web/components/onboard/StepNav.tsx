interface Props {
  onBack?: () => void;
  onNext: () => void;
  nextDisabled?: boolean;
}

export function StepNav({ onBack, onNext, nextDisabled = false }: Props) {
  return (
    <div className="onboard-nav">
      {onBack && (
        <button type="button" className="btn btn-outline" onClick={onBack}>
          Back
        </button>
      )}
      <button type="button" className="btn btn-primary" disabled={nextDisabled} onClick={onNext}>
        Next
      </button>
    </div>
  );
}
