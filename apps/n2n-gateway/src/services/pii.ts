export class PIIService {
  private readonly EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  private readonly PHONE_REGEX = /(\+?\d{1,3}[-.\s]?)?(\(?\d{3}\)?[-.\s]?)?\d{3}[-.\s]?\d{4}/g;
  private readonly CREDIT_CARD_REGEX = /\b(?:\d{4}[ -]?){3}\d{4}\b/g;

  /**
   * Scans a string and masks PII. Returns the masked string and a mapping of tokens to original values.
   */
  public redact(text: string): { redactedText: string; map: Record<string, string> } {
    let redactedText = text;
    const map: Record<string, string> = {};
    let counter = 1;

    // Mask Emails
    redactedText = redactedText.replace(this.EMAIL_REGEX, (match) => {
      const token = `[EMAIL_${counter++}]`;
      map[token] = match;
      return token;
    });

    // Mask Credit Cards
    redactedText = redactedText.replace(this.CREDIT_CARD_REGEX, (match) => {
      const token = `[CARD_${counter++}]`;
      map[token] = match;
      return token;
    });

    // Mask Phones
    redactedText = redactedText.replace(this.PHONE_REGEX, (match) => {
      const token = `[PHONE_${counter++}]`;
      map[token] = match;
      return token;
    });

    return { redactedText, map };
  }

  /**
   * Restores original values using the token map.
   */
  public restore(text: string, map: Record<string, string>): string {
    let restoredText = text;
    for (const [token, original] of Object.entries(map)) {
      // Create a global regex to replace all instances of the token
      const tokenRegex = new RegExp(token.replace(/\[/g, '\\[').replace(/\]/g, '\\]'), 'g');
      restoredText = restoredText.replace(tokenRegex, original);
    }
    return restoredText;
  }
}
