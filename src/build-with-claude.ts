// Sends the build CTAs to the editor this build targets. The markup carries the
// production editor, which is what a visitor with no JS needs.

const repoint = (id: string, path: string) => {
  const link = document.getElementById(id);
  if (link instanceof HTMLAnchorElement) {
    link.href = `${EDITOR_URL}${path}`;
  }
};

repoint("build-it-here", "/new?scratch=1");
repoint("build-with-claude", "/new");

export {};
