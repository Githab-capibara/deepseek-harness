/**
 * dsh-mcp-schema-trimmer: a tool schema the model cannot read is a tool the
 * model cannot call.
 *
 * An MCP server advertises whatever documentation it likes. The GitNexus
 * server, for instance, describes `impact` in fifteen thousand characters and
 * lists only `direction` as required, while the server itself refuses the call
 * without a `target`. A model that reads that catalogue loses the arguments it
 * needs and repeats the same failing call until the turn budget runs out.
 *
 * This plugin rewrites the tool schemas the agent sees:
 *
 *   - a description longer than the budget is cut to the budget, at a sentence
 *     boundary where one exists;
 *   - the `required` list is the one the server validates, not the one it
 *     advertises, for the tools whose contract the fork knows;
 *   - a tool whose server demands an argument the schema does not mark
 *     required has that argument marked, so the model supplies it.
 *
 * The schemas stay faithful to the server: only the model's view changes.
 *
 * @module dsh-mcp-schema-trimmer
 */

import z from '@deepseek-ai/schemastery';
import { name } from './constants.js';

export { name };

/** The description budget: a model reads a long description as noise. */
const DEFAULT_DESCRIPTION_LIMIT = 2000;

/**
 * The arguments a server demands but does not mark required, per tool.
 *
 * The GitNexus server validates these itself and refuses the call without
 * them, so a schema that hides them sends the model into a repeat loop.
 */
const REQUIRED_BY_TOOL = {
    'mcp__gitnexus__impact': ['target', 'direction'],
    'mcp__gitnexus__api_impact': ['target'],
    'mcp__gitnexus__context': [],
    'mcp__gitnexus__query': ['search_query'],
};

/** How a tool's name ends, so the server name may be absent from the public one. */
function matchesTool(toolName, suffix) {
    return toolName === suffix || toolName.endsWith(`__${suffix}`);
}

/**
 * Cut a description to the budget, at a sentence boundary where one exists.
 *
 * @param {string} description - the server's description.
 * @param {number} limit - the budget in characters.
 * @returns {string} the description the model sees.
 */
export function trimDescription(description, limit) {
    if (typeof description !== 'string' || description.length <= limit)
        return description;
    const head = description.slice(0, limit);
    const boundary = Math.max(
        head.lastIndexOf('. '),
        head.lastIndexOf('.\n'),
        head.lastIndexOf('\n\n'),
    );
    const cut = boundary > limit * 0.5 ? head.slice(0, boundary + 1) : head;
    return `${cut}\n[truncated: ${description.length - cut.length} more characters]`;
}

/**
 * The required arguments the model must supply for one tool.
 *
 * @param {string} toolName - the model-facing tool name.
 * @param {any} schema - the advertised JSON schema.
 * @returns {string[]} the required argument names.
 */
export function requiredFor(toolName, schema) {
    const advertised = Array.isArray(schema?.required) ? schema.required : [];
    for (const [suffix, extra] of Object.entries(REQUIRED_BY_TOOL)) {
        if (!matchesTool(toolName, suffix))
            continue;
        return [...new Set([...advertised, ...extra])];
    }
    return advertised;
}

export const Config = z.object({
    /** The description budget: a model reads a long description as noise. */
    descriptionLimit: z.number().default(DEFAULT_DESCRIPTION_LIMIT).volatile(),
});

/**
 * Read one configuration field, unwrapping the reference the platform wraps a
 * volatile field in.
 *
 * @param {any} field - the raw field value.
 * @param {any} fallback - the value used when the field carries none.
 * @returns {any} the current value.
 */
function readField(field, fallback) {
    if (field === undefined || field === null)
        return fallback;
    if (typeof field === 'object' && typeof field.get === 'function') {
        const value = field.get();
        return value === undefined || value === null ? fallback : value;
    }
    return field;
}

/**
 * Install the plugin.
 *
 * @param {any} ctx - the plugin context.
 * @param {any} config - the plugin's configuration.
 * @returns {Promise<void>} resolves once the listener is installed.
 */
export async function apply(ctx, config) {
    const raw = config ?? {};
    const limit = Number(readField(raw.descriptionLimit, DEFAULT_DESCRIPTION_LIMIT));
    const logger = ctx.logger?.('mcp-schema-trimmer');

    // `tools/change` carries no payload: it only says the catalogue moved. The
    // plugin therefore reads the catalogue and rewrites the MCP entries in it.
    const trimCatalogue = () => {
        // The service is read through `get`, so the plugin does not depend on
        // the host exposing it as a property.
        const tools = ctx.get('tools');
        if (tools === undefined || typeof tools.definitions !== 'function')
            return;
        let definitions;
        try {
            definitions = tools.definitions();
        }
        catch (error) {
            return;
        }
        if (!Array.isArray(definitions))
            return;
        for (const definition of definitions) {
            trimDefinition(definition);
        }
    };

    const trimDefinition = (definition) => {
        if (definition === undefined || typeof definition.name !== 'string')
            return;
        if (!definition.name.startsWith('mcp__'))
            return;
        const description = typeof definition.description === 'string' ? definition.description : '';
        if (description.length > limit) {
            definition.description = trimDescription(description, limit);
        }
        const parameters = definition.parameters;
        if (parameters === null || typeof parameters !== 'object')
            return;
        const required = requiredFor(definition.name, parameters);
        if (required.length === 0)
            return;
        const advertised = Array.isArray(parameters.required) ? parameters.required : [];
        if (required.every((item) => advertised.includes(item)))
            return;
        parameters.required = required;
        logger?.info?.('%s: required arguments are %s', definition.name, required.join(', '));
    };

    ctx.on('tools/change', () => {
        trimCatalogue();
    });
    trimCatalogue();
}
