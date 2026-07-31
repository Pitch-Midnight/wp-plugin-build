<?php

/**
 * Fired during plugin activation.
 *
 * @since      1.0.0
 * @package    Plugin_Name
 * @subpackage Plugin_Name/includes
 * @author     The Rite Sites <theritesites@gmail.com>
 * @link       theritesites.com
 */
class Plugin_Name_Activator {

	/**
	 * Run on activation.
	 *
	 * Keep this cheap and idempotent. It runs on every activation, including
	 * reactivation after an update, so anything here must be safe to repeat.
	 * Schema changes belong behind a stored version check, not here unguarded.
	 *
	 * @since  1.0.0
	 * @return void
	 */
	public static function activate() {

	}
}
