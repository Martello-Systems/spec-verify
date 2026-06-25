// This module mentions "/widgets" but declares NO route for it.
// The path appears only in a comment and as plain quoted string constants.
// route-exists path="/widgets" MUST report FAIL here (no false green): a quoted
// literal in a comment, a log line, or a doc constant is not a route.
const DOCS_LINK = '/widgets'; // a documentation path, not a server route
console.log('see /widgets for the catalog');
const messages = { notFound: 'try /widgets instead' };

export { DOCS_LINK, messages };
