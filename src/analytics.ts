/**
 * Report to Rybbit what a visitor does here that is not a click on an element
 * tagged `data-rybbit-event`, which Rybbit's script reports itself.
 *
 * archival.dev and the editor share one Rybbit site, which joins a visit that
 * crosses to the editor into one session, so these sit in the same timeline as
 * the checkout it ended in.
 */
type EventData = Record<string, string | number>;

export const track = (event: string, data?: EventData) => {
  (
    window as unknown as {
      rybbit?: { event: (name: string, properties?: EventData) => void };
    }
  ).rybbit?.event(event, data);
};
