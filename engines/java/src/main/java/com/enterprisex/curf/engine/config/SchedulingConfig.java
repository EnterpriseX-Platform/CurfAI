package com.enterprisex.curf.engine.config;

import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.annotation.EnableScheduling;

/** Switches on {@code @Scheduled} jobs, such as removing exports past their retention. */
@Configuration
@EnableScheduling
public class SchedulingConfig {}
