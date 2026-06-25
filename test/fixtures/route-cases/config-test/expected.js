// A test fixture constant, not a route declaration: no `method:` key nearby.
// route-exists path="/widgets" must report FAIL here.
const expected = { route: '/widgets', status: 200 };

export { expected };
