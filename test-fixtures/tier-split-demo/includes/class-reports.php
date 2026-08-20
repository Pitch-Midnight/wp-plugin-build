<?php
class TSD_Reports {

	public function free_report() {
		return 'free data';
	}

	#[PM\Premium]
	public function segmentation_report() {
		return 'premium data';
	}

	public function dispatch( $type ) {
		if ( $type === 'free' ) {
			return $this->free_report();
		}
		// <pm:premium>
		if ( $type === 'segments' ) {
			return $this->segmentation_report();
		}
		// </pm:premium>
		return null;
	}
}
