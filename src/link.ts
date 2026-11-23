// Pairing codes are approved in the editor, where a person is signed in. Links
// an agent printed with this site's address land there with their code.

const target = new URL(`${EDITOR_URL}/link`);
const code = new URL(window.location.href).searchParams.get("c");
if (code) {
  target.searchParams.set("c", code);
}
window.location.replace(target);

export {};
