<?php

/**
 * Fired when the plugin is deleted.
 *
 * This runs on delete only, not on deactivation. It is the one place in the
 * plugin allowed to destroy data, and it runs without the plugin loaded - no
 * classes, no constants, nothing from the bootstrap file is available here.
 *
 * Default position for this suite is to leave customer data in place. A
 * customer who deletes a plugin to troubleshoot and loses their history has
 * been failed by the plugin, not served by it. Remove options and transients;
 * leave tables and order meta unless the plugin offers an explicit
 * "delete my data on uninstall" setting and it is switched on.
 *
 * @since      1.0.0
 * @package    Plugin_Name
 * @author     The Rite Sites <theritesites@gmail.com>
 * @link       theritesites.com
 */

// If uninstall was not called by WordPress, abort.
if ( ! defined( 'WP_UNINSTALL_PLUGIN' ) ) {
	die;
}
