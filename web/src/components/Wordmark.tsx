/**
 * Type-set wordmark (design §1: never Straddle's logo assets — type only).
 * "Straddle" carries the brand weight; the rest stays plain.
 */
export function Wordmark() {
  return (
    <span className="text-[1.125rem] leading-none text-fg">
      <span className="font-semibold">Straddle</span>
      <span className="font-normal"> Sandbox Explorer</span>
    </span>
  );
}
