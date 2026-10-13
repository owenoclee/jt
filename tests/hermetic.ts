/**
 * Imported for its side effect by every test that pushes.
 *
 * jt reads the user's own ~/.config/jt/settings.json to decide whether a push needs a
 * review. Left alone, a developer's real auto-allow rules would change how these tests
 * behave on their machine — so HOME points at an empty directory for the whole run
 * (the detached review server inherits it).
 */
Deno.env.set("HOME", Deno.makeTempDirSync({ prefix: "jt-test-home-" }));
