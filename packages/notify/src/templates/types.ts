/** Every template renders to a subject plus HTML and plain-text bodies. */
export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}
