function isAsciiControlCharacter(character: string): boolean {
  const code = character.charCodeAt(0);
  return code < 0x20 || code === 0x7f;
}

export function containsAsciiControlCharacters(value: string): boolean {
  for (const character of value) {
    if (isAsciiControlCharacter(character)) return true;
  }
  return false;
}

export function replaceAsciiControlCharacters(value: string): string {
  return Array.from(value, (character) =>
    isAsciiControlCharacter(character) ? " " : character,
  ).join("");
}
