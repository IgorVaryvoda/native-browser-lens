/** Studio's tokens switch on a `.dark` class; Lens follows the system and browser setting. */
export function followSystemTheme() {
  const query = matchMedia('(prefers-color-scheme: dark)');
  const apply = () => document.documentElement.classList.toggle('dark', query.matches);
  apply();
  query.addEventListener('change', apply);
}
