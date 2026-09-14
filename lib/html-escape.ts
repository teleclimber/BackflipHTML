/**
 * Escape text for HTML, attribute values included.
 *
 * `"` is escaped along with `&<>`, so one function serves both positions and a
 * caller never has to pick the right one.
 */
export function escapeHtml(s: string): string {
	return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}
