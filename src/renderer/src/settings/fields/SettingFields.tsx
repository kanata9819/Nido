// The controls of the settings panel. Each draws one labeled setting; the label is
// translated, and the setting is saved by its setter.
import { useI18n } from '../../i18n';

/** A setting that is on or off. */
export function Toggle({
	label,
	checked,
	onChange
}: {
	label: string;
	checked: boolean;
	onChange: (checked: boolean) => void;
}): React.JSX.Element {
	const t = useI18n();
	return (
		<label>
			{t(label)}{' '}
			<input
				type="checkbox"
				checked={checked}
				onChange={(event) => onChange(event.target.checked)}
			/>
		</label>
	);
}

/**
 * A number setting. While typing, only valid values are applied; leaving the field shows the
 * applied value again.
 */
export function NumberField({
	label,
	value,
	min,
	max,
	step,
	unit,
	className,
	onChange
}: {
	label: string;
	value: number;
	min: number;
	max: number;
	step: number;
	/** Shown after the field, such as px. */
	unit?: string;
	className?: string;
	onChange: (value: number) => void;
}): React.JSX.Element {
	const t = useI18n();
	return (
		<label className={className}>
			{t(label)}{' '}
			<input
				type="number"
				min={String(min)}
				max={String(max)}
				step={String(step)}
				defaultValue={value}
				onChange={(event) => {
					if (event.target.value && event.target.validity.valid) {
						onChange(event.target.valueAsNumber);
					}
				}}
				onBlur={(event) => {
					event.target.value = String(value);
				}}
			/>
			{unit && <span>{unit}</span>}
		</label>
	);
}

/** A setting chosen from a list. Option labels are translated unless `translate` is false. */
export function Choice<T extends string>({
	label,
	value,
	options,
	translate = true,
	autoFocus,
	onChange
}: {
	label: string;
	value: T;
	options: readonly (readonly [T, string])[];
	translate?: boolean;
	autoFocus?: boolean;
	onChange: (value: T) => void;
}): React.JSX.Element {
	const t = useI18n();
	return (
		<label>
			{t(label)}
			<select
				autoFocus={autoFocus}
				value={value}
				onChange={(event) => onChange(event.target.value as T)}
			>
				{options.map(([option, title]) => (
					<option key={option} value={option}>
						{translate ? t(title) : title}
					</option>
				))}
			</select>
		</label>
	);
}

/** The explanation below a setting. */
export function Hint({ text }: { text: string }): React.JSX.Element {
	const t = useI18n();
	return <small>{t(text)}</small>;
}
