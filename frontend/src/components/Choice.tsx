import { useId } from "react";
import { Field, FieldLabel } from "./ui/field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";

export interface Option {
  value: string;
  label: string;
  disabled?: boolean;
}

export function Choice({
  label,
  value,
  onChange,
  options,
  disabled,
  id,
  className,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Option[];
  disabled?: boolean;
  id?: string;
  className?: string;
}) {
  const generated = useId();
  const control = id || generated;
  return (
    <Field className={className || "gap-1.5"}>
      <FieldLabel htmlFor={control}>{label}</FieldLabel>
      <Select value={value} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger id={control} className="w-full" aria-label={label}>
          <SelectValue placeholder="Choose" />
        </SelectTrigger>
        <SelectContent position="popper">
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value} disabled={option.disabled}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
}
