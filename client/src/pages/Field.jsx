import { useState } from 'react';

// Labelled input with inline error message and an optional show/hide toggle for passwords.
export default function Field({ label, type = 'text', error, hint, ...props }) {
  const [visible, setVisible] = useState(false);
  const isPassword = type === 'password';
  const id = props.name;
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;

  return (
    <div className={`field ${error ? 'has-error' : ''}`}>
      <label htmlFor={id}>{label}</label>
      <div className="input-wrap">
        <input
          id={id}
          type={isPassword && visible ? 'text' : type}
          aria-invalid={Boolean(error)}
          aria-describedby={describedBy}
          {...props}
        />
        {isPassword && (
          <button type="button" className="toggle" onClick={() => setVisible((v) => !v)}
            aria-label={visible ? 'Hide password' : 'Show password'}>
            {visible ? 'Hide' : 'Show'}
          </button>
        )}
      </div>
      {error ? <p className="field-error" id={`${id}-error`}>{error}</p>
        : hint ? <p className="field-hint" id={`${id}-hint`}>{hint}</p> : null}
    </div>
  );
}
