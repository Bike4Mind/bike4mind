/** The body as JSON when it parses, else the raw text, so an error page still reaches the logs and `raw`. */
export const readJson = async (response: Response): Promise<unknown> => {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};
