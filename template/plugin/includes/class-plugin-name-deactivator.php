<?php

/**
 * Fired during plugin deactivation.
 *
 * @since      1.0.0
 * @package    Plugin_Name
 * @subpackage Plugin_Name/includes
 * @author     The Rite Sites <theritesites@gmail.com>
 * @link       theritesites.com
 */
class Plugin_Name_Deactivator {

	/**
	 * Run on deactivation.
	 *
	 * Deactivation is not uninstallation. Clear scheduled events and transients
	 * here; leave customer data alone. Data removal belongs in uninstall.php,
	 * which only runs on delete.
	 *
	 * @since  1.0.0
	 * @return void
	 */
	public static function deactivate() {

	}
}
