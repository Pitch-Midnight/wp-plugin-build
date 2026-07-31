<?php

/**
 * The plugin bootstrap file.
 *
 * This file is read by WordPress to generate the plugin information in the
 * admin plugins area. It also defines the plugin constants and starts the
 * plugin.
 *
 * @link              theritesites.com
 * @since             1.0.0
 * @package           Plugin_Name
 *
 * @wordpress-plugin
 * Plugin Name:       Plugin Name
 * Plugin URI:        theritesites.com/plugins/plugin-name
 * Description:       PLUGIN_DESCRIPTION
 * Version:           1.0.0
 * Requires at least: 6.4
 * Requires PHP:      7.4
 * Author:            The Rite Sites
 * Author URI:        theritesites.com
 * License:           GPL-2.0+
 * License URI:       http://www.gnu.org/licenses/gpl-2.0.txt
 * Text Domain:       plugin-name
 * Domain Path:       /languages
 */

// If this file is called directly, abort.
if ( ! defined( 'WPINC' ) ) {
	die;
}

/**
 * The plugin version.
 *
 * Keep this identical to the `Version:` header above, to `version` in
 * package.json, and to `Stable tag` plus the newest changelog entry in
 * README.txt. `trs-verify-versions.js` fails the release when they disagree,
 * and it finds this constant automatically because the name ends in VERSION.
 */
define( 'PLUGIN_NAME_VERSION', '1.0.0' );

/**
 * The absolute path to this plugin's directory, with a trailing slash.
 */
define( 'PLUGIN_NAME_PATH', plugin_dir_path( __FILE__ ) );

/**
 * The public URL of this plugin's directory, with a trailing slash.
 */
define( 'PLUGIN_NAME_URL', plugin_dir_url( __FILE__ ) );

/**
 * The plugin slug, which is also the text domain and the installed directory
 * name. It must match `trsPackage.slug` in package.json - that value becomes
 * the folder inside the release zip, and a mismatch silently breaks updates
 * for existing installs rather than failing visibly.
 */
define( 'PLUGIN_NAME_SLUG', 'plugin-name' );

require_once PLUGIN_NAME_PATH . 'includes/class-plugin-name-activator.php';
require_once PLUGIN_NAME_PATH . 'includes/class-plugin-name-deactivator.php';
require_once PLUGIN_NAME_PATH . 'includes/class-plugin-name-i18n.php';
require_once PLUGIN_NAME_PATH . 'includes/class-plugin-name.php';

register_activation_hook( __FILE__, array( 'Plugin_Name_Activator', 'activate' ) );
register_deactivation_hook( __FILE__, array( 'Plugin_Name_Deactivator', 'deactivate' ) );

/**
 * Start the plugin.
 *
 * Deliberately hooked rather than called at file scope: at include time the
 * rest of WordPress may not have loaded, and a plugin that does work here is
 * a plugin whose load order you cannot reason about later.
 *
 * @since 1.0.0
 * @return void
 */
function run_plugin_name() {

	$plugin = new Plugin_Name();
	$plugin->run();
}
add_action( 'plugins_loaded', 'run_plugin_name' );
