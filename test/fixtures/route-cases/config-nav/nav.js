// A navigation menu, not a route table: the path key carries no `method:`.
// route-exists path="/widgets" must report FAIL here.
export const nav = [
  { path: '/widgets', icon: 'box', label: 'Widgets' },
  { path: '/about', icon: 'info', label: 'About' },
];
